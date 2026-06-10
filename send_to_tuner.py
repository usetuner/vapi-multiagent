"""
Send your VAPI calls to Tuner
==============================
Drop this file next to your VAPI server and call `send_call_to_tuner(message)`
from inside your `end-of-call-report` handler. Every finished call — including
its tool calls and tool results — will show up under your Tuner agent.

Setup (4 values, all from the Tuner dashboard):
  1. TUNER_BASE_URL   -> your Tuner API base URL
  2. TUNER_API_KEY    -> Workspace Settings > API Keys           (starts with "tr_api_")
  3. TUNER_WORKSPACE  -> Workspace > General Settings
  4. TUNER_AGENT_ID   -> create a "Custom API" agent in Tuner, then
                         Agent Settings > Agent Connection > Agent ID

Install:  pip install requests
"""

import json
import logging
import math
from datetime import datetime

import requests

logger = logging.getLogger("tuner")

# =============================================================================
# CONFIG — fill these in
# =============================================================================
TUNER_BASE_URL = "https://api.tuner.ai"  # your Tuner API base URL
TUNER_API_KEY = "tr_api_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
TUNER_WORKSPACE = 0  # your workspace id (int)
TUNER_AGENT_ID = "your-custom-api-agent-id"


# =============================================================================
# THE FUNCTION — call this from your end-of-call handler
# =============================================================================
def send_call_to_tuner(message: dict) -> None:
    """Forward one VAPI `end-of-call-report` message to Tuner.

    `message` is the `body["message"]` object VAPI posts to your webhook.
    Safe to call inline — it never raises; failures are logged, not thrown.
    """
    try:
        call = message.get("call", {})
        artifact = message.get("artifact", {})

        call_id = call.get("id")
        if not call_id:
            logger.warning(
                "Tuner: end-of-call-report has no call id — call will not be sent"
            )
            return

        # VAPI keeps the timed, structured transcript under artifact.messages.
        raw_messages = artifact.get("messages") or message.get("messages") or []
        call_start_ms = _to_epoch_ms(message.get("startedAt"))
        segments = _build_segments(raw_messages, call_start_ms)
        if not segments:
            logger.warning(
                "Tuner: no transcript segments found — call %s will not be sent",
                call_id,
            )
            return

        # Attach per-turn latency (STT/LLM/TTS/e2e) to each agent turn.
        turn_latencies = (artifact.get("performanceMetrics") or {}).get("turnLatencies")
        if turn_latencies:
            _enrich_with_turn_latencies(segments, turn_latencies)
        segments = [_strip_none(s) for s in segments]

        stereo_url = message.get("stereoRecordingUrl") or artifact.get(
            "stereoRecordingUrl"
        )
        recording_url = (
            message.get("recordingUrl") or artifact.get("recordingUrl") or stereo_url
        )
        if not recording_url:
            logger.warning(
                "Tuner: no recording URL — call %s will not be sent to Tuner", call_id
            )
            return

        call_analysis, call_successful = _map_analysis(message)
        payload = {
            "call_id": call_id,
            "call_type": _map_call_type(call.get("type")),
            "start_timestamp": call_start_ms,
            "end_timestamp": _to_epoch_ms(message.get("endedAt")),
            "recording_url": recording_url,
            "recording_multi_channel_url": stereo_url,
            "transcript": message.get("transcript") or artifact.get("transcript"),
            "transcript_with_tool_calls": segments,
            "call_status": "call_ended",
            "disconnection_reason": (message.get("endedReason") or "")[:100] or None,
            "caller_phone_number": call.get("customer", {}).get("number"),
            "call_successful": call_successful,
            "call_analysis": call_analysis,
            "call_cost": _cost_in_cents(message.get("cost")),
        }
        # Drop empty optional fields so we only send what we actually have.
        payload = {k: v for k, v in payload.items() if v is not None}

        response = requests.post(
            f"{TUNER_BASE_URL}/api/v1/public/call",
            params={
                "workspace_id": TUNER_WORKSPACE,
                "agent_remote_identifier": TUNER_AGENT_ID,
            },
            headers={"Authorization": f"Bearer {TUNER_API_KEY}"},
            json=payload,
            timeout=15,
        )
        if response.status_code in (200, 201):
            logger.info("Tuner: sent call %s", call_id)
        elif response.status_code == 409:
            logger.info("Tuner: call %s already sent", call_id)  # idempotent, fine
        else:
            logger.error("Tuner: failed (%s) %s", response.status_code, response.text)
    except Exception as exc:  # never let Tuner break your call handling
        logger.error("Tuner: error sending call: %s", exc)


# =============================================================================
# CALL-LEVEL MAPPING — mirrors how Tuner maps VAPI calls natively.
# =============================================================================
# VAPI call types -> Tuner's canonical snake_case values; unknown types pass through.
VAPI_CALL_TYPE_MAP = {
    "webCall": "web_call",
    "phoneCall": "phone_call",
    "sipCall": "sip_call",
}


def _map_call_type(vapi_type) -> str:
    """Normalize VAPI's camelCase call type to Tuner's snake_case."""
    if not vapi_type:
        return "phone_call"
    return VAPI_CALL_TYPE_MAP.get(vapi_type, vapi_type)


def _map_analysis(message: dict) -> tuple[dict | None, bool | None]:
    """Build Tuner's call_analysis ({summary, success_evaluation}) and call_successful."""
    call_analysis: dict = {}
    call_successful = None

    analysis = message.get("analysis") or {}
    if analysis.get("summary"):
        call_analysis["summary"] = analysis["summary"]
    success_eval = analysis.get("successEvaluation")
    if success_eval is not None:
        call_analysis["success_evaluation"] = success_eval
        call_successful = str(success_eval).lower() == "true"

    # Fall back to the top-level summary if analysis didn't carry one.
    if message.get("summary") and "summary" not in call_analysis:
        call_analysis["summary"] = message["summary"]

    return call_analysis or None, call_successful


def _cost_in_cents(cost) -> float | None:
    """VAPI reports cost in dollars; Tuner expects cents."""
    if not isinstance(cost, (int, float)):
        return None
    return round(cost * 100, 2)


def _strip_none(obj):
    """Drop None values recursively so segments only carry fields that exist."""
    if isinstance(obj, dict):
        return {k: _strip_none(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [_strip_none(x) for x in obj]
    return obj


# =============================================================================
# MAPPING — VAPI messages -> Tuner's transcript timeline.
# Mirrors Tuner's internal VAPI mapper so user/agent speech, tool calls, and
# tool results are all captured. VAPI roles map to Tuner roles like so:
#   user  -> user        bot         -> agent
#   tool_calls -> agent_function     tool_call_result -> agent_result
#   system -> dropped
# =============================================================================
def _build_segments(raw_messages: list, call_start_ms: int | None) -> list[dict]:
    """Convert VAPI's message list into Tuner transcript segments."""
    segments: list[dict] = []
    for m in raw_messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "user":
            seg = _speech_segment(m, "user", call_start_ms)
            if seg:
                segments.append(seg)
        elif role in ("bot", "assistant"):
            seg = _speech_segment(m, "agent", call_start_ms)
            if seg:
                segments.append(seg)
        elif role == "tool_calls":
            segments.extend(_tool_call_segments(m))
        elif role == "tool_call_result":
            segments.append(_tool_result_segment(m))
        # "system" and anything else is intentionally skipped.
    return segments


def _speech_segment(m: dict, role: str, call_start_ms: int | None) -> dict | None:
    """A user or agent spoken turn, with timing (and word-level timing if present).

    Tuner requires timing on every spoken turn. A segment with no resolvable timing
    would reject the whole call, so we skip it instead — same as Tuner does natively.
    """
    start_ms, end_ms, duration_ms = _segment_timing(m, call_start_ms)
    words = _words(m.get("metadata"), call_start_ms)

    has_timing = start_ms is not None and (
        end_ms is not None or duration_ms is not None
    )
    if not has_timing and not words:
        logger.warning(
            "Tuner: skipping untimed %s segment: %.50r", role, m.get("message") or ""
        )
        return None

    seg = {"role": role, "text": m.get("message")}
    if start_ms is not None:
        seg["start_ms"] = start_ms
    if end_ms is not None:
        seg["end_ms"] = end_ms
    if duration_ms is not None:
        seg["duration_ms"] = duration_ms
    if words:
        seg["words"] = words
    return seg


def _tool_call_segments(m: dict) -> list[dict]:
    """One agent_function segment per tool the agent invoked."""
    seconds = m.get("secondsFromStart")
    start_ms = math.ceil(seconds * 1000) if seconds is not None else None
    out = []
    for tc in m.get("toolCalls", []):
        fn = tc.get("function", {})
        params = _maybe_json(fn.get("arguments"))
        out.append(
            {
                "role": "agent_function",
                "start_ms": start_ms,
                "end_ms": start_ms,
                "tool": {
                    "name": fn.get("name"),
                    "request_id": tc.get("id"),
                    "params": params if isinstance(params, dict) else None,
                    "start_ms": start_ms,
                    "end_ms": start_ms,
                },
            }
        )
    return out


def _tool_result_segment(m: dict) -> dict:
    """The result returned by a tool. Non-dict results are wrapped so nothing is lost."""
    seconds = m.get("secondsFromStart")
    start_ms = math.ceil(seconds * 1000) if seconds is not None else None
    parsed = _maybe_json(m.get("result"))
    if isinstance(parsed, dict):
        result = parsed
    elif isinstance(parsed, (list, str)) and parsed:
        result = {"value": parsed}
    else:
        result = None

    is_error, error_msg = _detect_tool_error(m, parsed)
    tool = {
        "name": m.get("name"),
        "request_id": m.get("toolCallId"),
        "result": result,
        "is_error": is_error,
        "start_ms": start_ms,
        "end_ms": start_ms,
    }
    if error_msg:
        tool["error"] = error_msg
    return {
        "role": "agent_result",
        "start_ms": start_ms,
        "end_ms": start_ms,
        "tool": tool,
    }


def _detect_tool_error(m: dict, parsed) -> tuple[bool, str | None]:
    """Detect whether a tool result represents an error, and extract its message.

    VAPI has no single standard error flag, so we check the explicit signals that
    show up in practice — an error field on the message itself, or an error-shaped
    result payload — rather than guessing from free text.
    """
    # 1. Explicit flags on the VAPI message (extra fields are allowed by VAPI).
    msg_error = m.get("error")
    if isinstance(msg_error, str) and msg_error:
        return True, msg_error
    if any(m.get(k) is True for k in ("error", "isError", "is_error")):
        return True, msg_error if isinstance(msg_error, str) else None
    if m.get("success") is False:
        return True, None

    # 2. Error-shaped result payload, e.g. {"error": "..."} or {"status": "failed"}.
    if isinstance(parsed, dict):
        res_error = parsed.get("error")
        if res_error:
            return True, res_error if isinstance(res_error, str) else None
        if parsed.get("success") is False:
            return True, None
        status = parsed.get("status")
        if isinstance(status, str) and status.lower() in ("error", "failed", "failure"):
            msg = parsed.get("message")
            return True, msg if isinstance(msg, str) else None

    return False, None


def _enrich_with_turn_latencies(segments: list[dict], turn_latencies: list) -> None:
    """Stamp each agent turn with its latency breakdown, in transcript order.

    VAPI's performanceMetrics.turnLatencies is ordered by agent turn, so we match
    the Nth entry to the Nth agent segment.
    """
    idx = 0
    for seg in segments:
        if seg.get("role") != "agent":
            continue
        if idx >= len(turn_latencies):
            break
        tl = turn_latencies[idx]
        metadata = {
            "e2e_latency": tl.get("turnLatency"),
            "stt_node_ttfb": tl.get("transcriberLatency"),
            "llm_node_ttft": tl.get("modelLatency"),
            "tts_node_ttfb": tl.get("voiceLatency"),
        }
        metadata = {k: v for k, v in metadata.items() if v is not None}
        if metadata:
            seg["metadata"] = metadata
        idx += 1


# =============================================================================
# TIMING HELPERS
# =============================================================================
def _segment_timing(m: dict, call_start_ms: int | None):
    """Resolve (start_ms, end_ms, duration_ms) relative to call start.

    Prefer secondsFromStart (already relative to call start). Fall back to the
    absolute epoch `time`/`endTime` fields when call start is known.
    """
    start_ms = end_ms = duration_ms = None
    seconds = m.get("secondsFromStart")
    if seconds is not None:
        start_ms = math.ceil(seconds * 1000)
    if m.get("duration") is not None:
        duration_ms = math.ceil(m["duration"])

    if start_ms is not None and duration_ms is not None:
        end_ms = start_ms + duration_ms
    elif call_start_ms is not None:
        if m.get("time") is not None and start_ms is None:
            start_ms = math.ceil(m["time"] - call_start_ms)
        if m.get("endTime") is not None:
            end_ms = math.ceil(m["endTime"] - call_start_ms)
        if start_ms is not None and end_ms is not None:
            duration_ms = end_ms - start_ms
    return start_ms, end_ms, duration_ms


def _words(metadata, call_start_ms: int | None) -> list[dict] | None:
    """Word-level timing from VAPI's wordLevelConfidence (start/end are epoch ms)."""
    if not isinstance(metadata, dict):
        return None
    raw = metadata.get("wordLevelConfidence")
    if not isinstance(raw, list) or not raw:
        return None
    words = []
    for w in raw:
        if (
            not isinstance(w, dict)
            or not w.get("word")
            or "start" not in w
            or "end" not in w
        ):
            continue
        offset = call_start_ms or 0
        words.append(
            {
                "word": w.get("word"),
                "start_ms": math.ceil(w["start"] - offset),
                "end_ms": math.ceil(w["end"] - offset),
                "confidence": w.get("confidence"),
            }
        )
    return words or None


def _maybe_json(value):
    """VAPI sends tool arguments/results as JSON strings; parse them, else pass through."""
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, ValueError):
        return value


def _to_epoch_ms(value) -> int | None:
    """Accept VAPI's ISO string ('2026-06-10T...Z') or a number; return epoch ms."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
