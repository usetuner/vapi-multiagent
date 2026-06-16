"""
Send your VAPI calls to Tuner
==============================
Drop this file next to your VAPI server and call ``send_call_to_tuner(message)``
from inside your ``end-of-call-report`` handler, that's the whole integration::

    send_call_to_tuner(message)   # fire-and-forget; never raises

    # optional: attach your own metadata object to the call in Tuner
    send_call_to_tuner(message, {"customer_id": "cus_123", "campaign": "june-promo"})

Every finished call, including its tool calls and tool results, will show up
under your Tuner agent.

The function automatically downloads VAPI's call log (``artifact.logUrl``, one
extra GET, no API key needed) to enrich the call with exact per-turn latencies
and interruptions. If the log is missing or unreadable, it falls back to
payload-only enrichment by itself, the transcript never depends on the log, and
a call is never lost because of it.

Because this is synchronous and may sleep between retries, call it from a
background thread/task in latency-sensitive handlers, e.g.::

    import threading
    threading.Thread(target=send_call_to_tuner, args=(message,), daemon=True).start()

Setup (4 values, all from the Tuner dashboard):
  1. TUNER_BASE_URL   -> your Tuner API base URL
  2. TUNER_API_KEY    -> Workspace Settings > API Keys           (starts with "tr_api_")
  3. TUNER_WORKSPACE  -> Workspace > General Settings
  4. TUNER_AGENT_ID   -> create a "Custom API" agent in Tuner, then
                         Agent Settings > Agent Connection > Agent ID

Install:  pip install requests
"""

from __future__ import annotations

import gzip
import logging
import math
import random
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional, Union
from urllib.parse import urlencode

import requests

logger = logging.getLogger("tuner")

# =============================================================================
# CONFIG, fill these in
# =============================================================================
TUNER_BASE_URL = "https://api.usetuner.ai"  # your Tuner API base URL
TUNER_API_KEY = "tr_api_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
TUNER_WORKSPACE = 0  # your workspace id (number)
TUNER_AGENT_ID = "your-custom-api-agent-id"

# Network timeout & retry behavior for the POST to Tuner.
REQUEST_TIMEOUT_S = 15  # per-attempt timeout for the POST to Tuner
MAX_ATTEMPTS = 3  # retry attempts on transient failures (network, 408, 429, 5xx)

Json = dict[str, Any]

# VapiLog: raw JSONL text, or a list of parsed log-line objects.
VapiLog = Union[str, list[Json]]

# Sentinel meaning "prefetched_log was not passed" (None means "no log, skip fetch").
_MISSING = object()


# =============================================================================
# THE FUNCTION, call this from your end-of-call handler
# =============================================================================
def send_call_to_tuner(
    message: Json,
    metadata: Optional[Json] = None,
    prefetched_log: Any = _MISSING,  # sentinel "not provided"; None == "no log"
) -> None:
    """
    Forward one VAPI ``end-of-call-report`` message to Tuner.

    ``message`` is the ``body.message`` object VAPI posts to your webhook.
    ``metadata`` (optional) is a free-form object stored with the call in Tuner
    (e.g. your own customer id, campaign, A/B variant). Sent only when you
    provide it; nothing is sent by default.

    The VAPI call log is fetched internally from ``artifact.logUrl``; when that
    fails, the payload-only enrichment runs instead, fully automatic. Pass
    ``prefetched_log`` when you already downloaded the log (e.g. to save it
    locally) so it isn't fetched twice.

    Safe to call inline, it never raises; failures are logged, not raised.
    """
    try:
        call: Json = message.get("call") or {}
        artifact: Json = message.get("artifact") or {}

        call_id = call.get("id")
        if not call_id:
            logger.warning("Tuner: end-of-call-report has no call id, call will not be sent")
            return

        # VAPI keeps the timed, structured transcript under artifact.messages.
        raw_messages: list = artifact.get("messages") or message.get("messages") or []
        call_start_ms = _to_epoch_ms(message.get("startedAt"))
        segments = _build_segments(raw_messages, call_start_ms)
        if not segments:
            logger.warning(f"Tuner: no transcript segments found, call {call_id} will not be sent")
            return

        # Fetch VAPI's call log (one GET, no auth). None on any failure -> fallback.
        if prefetched_log is not _MISSING:
            log = prefetched_log
        else:
            log = fetch_vapi_log(artifact.get("logUrl") or message.get("logUrl"))

        # Attach per-turn latency: STT to the customer turn, LLM/TTS/e2e to the agent reply.
        # With a call log: exact interruptions + real metrics on post-tool replies.
        # Without (or if the log doesn't line up): the verified payload-only logic.
        turn_latencies: list = ((artifact.get("performanceMetrics") or {}).get("turnLatencies")) or []
        log_enriched = False
        if log:
            try:
                log_enriched = _enrich_from_log(segments, log, turn_latencies)
            except Exception as err:  # noqa: BLE001
                log_enriched = False
                logger.warning(
                    f"Tuner: log enrichment failed for call {call_id} ({err!r}), "
                    "using payload-only metrics"
                )
        if not log_enriched:
            if turn_latencies:
                _enrich_with_turn_latencies(segments, turn_latencies)
            # Without log ground truth, deduce barge-ins from timing overlap.
            _mark_interruptions(segments)
        # Re-join customer utterances that VAPI's stitcher sliced into two rows.
        _merge_user_slices(segments)
        segments = [_strip_none(s) for s in segments]

        stereo_url = message.get("stereoRecordingUrl") or artifact.get("stereoRecordingUrl")
        recording_url = message.get("recordingUrl") or artifact.get("recordingUrl") or stereo_url
        if not recording_url:
            logger.warning(f"Tuner: no recording URL, call {call_id} will not be sent to Tuner")
            return

        # Metadata is sent only when the caller provides it; Tuner accepts
        # free-form keys here and stores them with the call. It must be JSON-
        # serializable, anything else is dropped so the call itself still sends.
        meta: Optional[Json] = (
            metadata if isinstance(metadata, dict) and len(metadata) else None
        )
        if meta is not None:
            try:
                import json

                json.dumps(meta)
            except (TypeError, ValueError):
                logger.warning(
                    f"Tuner: metadata for call {call_id} is not JSON-serializable, sending without it"
                )
                meta = None

        call_analysis, call_successful = _map_analysis(message)
        # sip_call_id: the SIP Call-ID of the leg that reached VAPI, exposed by
        # VAPI as the "cid" variable (and as sbcCallSid). Tuner stores this same
        # id for its simulation calls, so it links the call back to a simulation
        # run. The correlation-id override variable is a last resort; nulls are
        # dropped below, so regular calls are unaffected.
        overrides_vars = (call.get("assistantOverrides") or {}).get("variableValues") or {}
        correlation_id = (
            overrides_vars.get("cid")
            or (call.get("transport") or {}).get("sbcCallSid")
            or (call.get("phoneCallProviderDetails") or {}).get("sbcCallId")
            or overrides_vars.get("correlation-id")
            or None
        )

        # recipient: the call's destination address.
        customer = call.get("customer") or {}
        recipient = customer.get("sipUri") or customer.get("number") or None
        payload: Json = {
            "call_id": call_id,
            "sip_call_id": correlation_id,
            "recipient": recipient,
            "call_type": _map_call_type(call.get("type")),
            "start_timestamp": call_start_ms,
            "end_timestamp": _to_epoch_ms(message.get("endedAt")),
            "recording_url": recording_url,
            "recording_multi_channel_url": stereo_url,
            "transcript": message.get("transcript") or artifact.get("transcript") or None,
            "transcript_with_tool_calls": segments,
            "call_status": "call_ended",
            "disconnection_reason": (
                (message["endedReason"][:100] or None)
                if isinstance(message.get("endedReason"), str)
                else None
            ),
            "caller_phone_number": customer.get("number") or None,
            "call_successful": call_successful,
            "call_analysis": call_analysis,
            "call_cost": _cost_in_cents(message.get("cost")),
            "metadata": meta,
        }
        # Drop empty optional fields so we only send what we actually have.
        payload = {k: v for k, v in payload.items() if v is not None}

        params = urlencode(
            {
                "workspace_id": str(TUNER_WORKSPACE),
                "agent_remote_identifier": TUNER_AGENT_ID,
            }
        )
        url = f"{TUNER_BASE_URL}/api/v1/public/call?{params}"
        headers = {
            "Authorization": f"Bearer {TUNER_API_KEY}",
            "Content-Type": "application/json",
        }

        # POST with retries. Transient failures (network errors, timeouts, 429,
        # 5xx) get up to 3 attempts with exponential backoff + jitter; other 4xx
        # are real errors that retrying can't fix, so they fail fast. Retrying is
        # safe because ingestion is idempotent: a duplicate call_id returns 409,
        # which counts as success.
        for attempt in range(1, MAX_ATTEMPTS + 1):
            status = 0
            detail = ""
            retry_after_ms = 0
            try:
                response = requests.post(
                    url, headers=headers, json=payload, timeout=REQUEST_TIMEOUT_S
                )
                status = response.status_code
                if status in (200, 201):
                    logger.info(
                        f"Tuner: sent call {call_id}" + (" (log-enriched)" if log_enriched else "")
                    )
                    return
                if status == 409:
                    logger.info(f"Tuner: call {call_id} already sent")  # idempotent, fine
                    return
                detail = response.text or ""
                retryable = status == 408 or status == 429 or status >= 500
                if not retryable:
                    logger.warning(
                        f"Tuner: call {call_id} failed ({status}), not retryable: {detail}"
                    )
                    return
                try:
                    ra = float(response.headers.get("retry-after", ""))
                    if math.isfinite(ra) and ra > 0:
                        retry_after_ms = min(ra * 1000, 30_000)
                except (TypeError, ValueError):
                    pass
            except requests.RequestException as err:
                detail = str(err)  # network error / timeout -> retryable

            if attempt < MAX_ATTEMPTS:
                backoff_ms = (2 ** attempt) * 1000 + random.random() * 1000  # ~2-3s, ~4-5s
                wait_ms = max(backoff_ms, retry_after_ms)
                logger.warning(
                    f"Tuner: attempt {attempt}/{MAX_ATTEMPTS} for call {call_id} failed "
                    f"({status or 'network'}), retrying in {round(wait_ms / 1000)}s"
                )
                time.sleep(wait_ms / 1000)
            else:
                logger.warning(
                    f"Tuner: call {call_id} failed after {MAX_ATTEMPTS} attempts "
                    f"({status or 'network'}) {detail}"
                )
    except Exception as err:  # noqa: BLE001
        # never let Tuner break your call handling
        logger.warning(f"Tuner: error sending call: {err!r}")


# =============================================================================
# VAPI CALL LOG, internal fetch + log-based enrichment
# =============================================================================
def fetch_vapi_log(log_url: Any) -> Optional[list[Json]]:
    """
    Download and parse a VAPI call log (``message.artifact.logUrl``).

    The log is a gzipped JSONL file on VAPI's storage; no API key is needed.
    Returns the parsed log lines, or None on any failure (missing URL, timeout,
    bad response), the caller then falls back to payload-only enrichment.
    """
    if not isinstance(log_url, str) or not log_url:
        return None
    try:
        res = requests.get(log_url, timeout=10)
        if not res.ok:
            logger.warning(
                f"Tuner: could not fetch VAPI call log (HTTP {res.status_code}), "
                "continuing without log enrichment"
            )
            return None
        buf = res.content

        if len(buf) >= 2 and buf[0] == 0x1F and buf[1] == 0x8B:
            # The log is gzipped, decompress with the stdlib.
            text = gzip.decompress(buf).decode("utf-8")
        else:
            text = buf.decode("utf-8", errors="replace")

        import json

        out: list[Json] = []
        for line in text.split("\n"):
            trimmed = line.strip()
            if not trimmed:
                continue
            try:
                out.append(json.loads(trimmed))
            except ValueError:
                # skip malformed lines
                pass
        return out or None
    except Exception as err:  # noqa: BLE001
        logger.warning(
            f"Tuner: could not read VAPI call log ({err!r}), continuing without log enrichment"
        )
        return None


def _parse_log_lines(log: VapiLog) -> list[Json]:
    """Accept raw JSONL text or an already-parsed list; return parsed log lines."""
    if not isinstance(log, str):
        return log
    import json

    lines: list[Json] = []
    for line in log.split("\n"):
        try:
            lines.append(json.loads(line))
        except ValueError:
            continue
    return [line for line in lines if line is not None]


def _normalize_log_events(log: VapiLog) -> list[dict]:
    """Pull the per-turn events we use out of the raw log lines."""
    lines = _parse_log_lines(log)

    events: list[dict] = []
    for line in lines:
        a = (line or {}).get("attributes")
        if not isinstance(a, dict):
            continue
        raw_turn = a.get("turnId")
        # numeric turnIds only; "CLEAN_UP" etc. are not conversation turns
        if raw_turn is None or not re.fullmatch(r"\d+", str(raw_turn)):
            continue
        if not isinstance(line.get("time"), (int, float)) or not isinstance(a.get("event"), str):
            continue
        events.append(
            {
                "turnId": int(raw_turn),
                "time": line["time"],
                "event": a["event"],
                "latency": a["latency"] if isinstance(a.get("latency"), (int, float)) else None,
                "wasInterruption": a.get("wasInterruption") is True,
            }
        )
    events.sort(key=lambda x: x["time"])
    return events


def _extract_fragments(log: VapiLog) -> list[dict]:
    """
    Pull the speech snippets out of the log: who said it, which turn, and when
    it was actually spoken (taken from the live partial transcripts, which are
    more reliable than the final transcript's arrival time).
    """
    lines = _parse_log_lines(log)

    frags: list[dict] = []
    partial_start: dict[str, Optional[float]] = {"user": None, "assistant": None}
    for line in lines:
        a = (line or {}).get("attributes")
        if not isinstance(a, dict):
            continue
        time_val = line["time"] if isinstance(line.get("time"), (int, float)) else 0
        channel = "user" if a.get("channel") == "user" else "assistant"

        if a.get("event") == "assistant.transcriber.partialTranscript":
            if partial_start[channel] is None:
                partial_start[channel] = time_val
            continue
        if a.get("event") != "assistant.transcriber.finalTranscript":
            continue
        if not isinstance(a.get("transcript"), str) or not a["transcript"]:
            continue

        raw_turn = a.get("turnId")
        turn_id = int(raw_turn) if raw_turn is not None and re.fullmatch(r"\d+", str(raw_turn)) else None
        frags.append(
            {
                "channel": channel,
                "turnId": turn_id,
                "text": a["transcript"],
                "time": time_val,
                "spokenTime": partial_start[channel] if partial_start[channel] is not None else time_val,
            }
        )
        partial_start[channel] = None  # next partial starts a new chain
    frags.sort(key=lambda x: x["time"])
    return frags


def _norm_text(s: Optional[str]) -> str:
    """Lowercase letters and digits only, cosmetic differences can never break matching."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _align_rows_to_fragments(segments: list[Json], frags: list[dict]):
    """
    Match every transcript row to the log snippets that make up its text.
    Each VAPI transcript row is the log's speech snippets glued together, so we
    re-spell the rows from the snippets, each row then knows exactly which
    snippets (and turns/timings) it is made of. If the texts don't line up,
    returns None and the simpler enrichment is used instead.

    Returns ``(frags_of, covered)`` where both are keyed by ``id(row)``.
    """
    frags_of: dict[int, list[dict]] = {}
    covered: dict[int, bool] = {}

    for channel, role in (("user", "user"), ("assistant", "agent")):
        rows = [s for s in segments if s.get("role") == role and isinstance(s.get("text"), str)]
        f_items = [
            {"frag": f, "text": _norm_text(f["text"])}
            for f in frags
            if f["channel"] == channel
        ]
        f_items = [f for f in f_items if f["text"]]
        r_items = [{"row": r, "text": _norm_text(r["text"])} for r in rows]

        big_r = "".join(r["text"] for r in r_items)
        big_f = "".join(f["text"] for f in f_items)
        if not big_r.startswith(big_f):
            return None  # real divergence -> don't trust the log

        # Walk both lists; each row consumes fragment characters and collects fragments.
        fi = 0
        f_off = 0
        for item in r_items:
            row = item["row"]
            text = item["text"]
            own: list[dict] = []
            need = len(text)
            got = 0
            while need > 0 and fi < len(f_items):
                f = f_items[fi]
                take = min(len(f["text"]) - f_off, need)
                own.append(f["frag"])
                need -= take
                got += take
                f_off += take
                if f_off == len(f["text"]):
                    fi += 1
                    f_off = 0
            frags_of[id(row)] = own
            covered[id(row)] = len(text) > 0 and got == len(text)

    return frags_of, covered


def _enrich_from_log(segments: list[Json], log: VapiLog, turn_latencies: list) -> bool:
    """
    Enrich the transcript using VAPI's call log, the most accurate source.
    The log tells us exactly which latency numbers belong to which rows, the
    true metrics for replies that follow a tool call, and exactly which agent
    sentences the customer interrupted.

    Returns True when applied; False means the log couldn't be used and the
    simpler payload-based enrichment runs instead.
    """
    events = _normalize_log_events(log)
    frags = _extract_fragments(log)
    if not events or not frags:
        return False

    # Group events by turn; "completed" turns produced agent output (speech or
    # a tool invocation), these are the turns turnLatencies entries describe.
    by_turn: dict[int, list[dict]] = {}
    for e in events:
        by_turn.setdefault(e["turnId"], []).append(e)
    completed_turn_ids = [
        tid
        for tid, evs in sorted(by_turn.items(), key=lambda kv: kv[0])
        if any(
            e["event"] in ("pipeline.botSpeechStarted", "assistant.tool.started") for e in evs
        )
    ]
    if not completed_turn_ids:
        return False

    # Bind rows to their fragments by text.
    aligned = _align_rows_to_fragments(segments, frags)
    if aligned is None:
        return False
    frags_of, covered = aligned

    # Figure out which turn produced each piece of agent speech, using WHEN it
    # was spoken vs when each turn started speaking (the log's own turn labels
    # can lag behind for interrupted speech, so timing is the reliable signal).
    bot_starts: list[dict] = []
    for tid in completed_turn_ids:
        for e in by_turn[tid]:
            if e["event"] == "pipeline.botSpeechStarted":
                bot_starts.append({"tid": tid, "time": e["time"]})
    bot_starts.sort(key=lambda b: b["time"])

    def producing_turn(t: float) -> Optional[int]:
        res: Optional[int] = None
        for b in bot_starts:
            if b["time"] <= t:
                res = b["tid"]
            else:
                break
        return res

    turns_of: dict[int, set] = {}
    for s in segments:
        own = frags_of.get(id(s))
        if not own:
            continue
        turns: set = set()
        if s.get("role") == "agent":
            for f in own:
                t = producing_turn(f["spokenTime"])
                if t is not None:
                    turns.add(t)
        else:
            # User tags are timely: the tag is the turn that started when they spoke.
            for f in own:
                if f["turnId"] is not None:
                    turns.add(f["turnId"])
        turns_of[id(s)] = turns

    # The final goodbye is often cut off before its transcript finalizes,
    # pair any leftover turns with the remaining unmatched agent rows.
    assigned: set = set()
    for s in segments:
        if s.get("role") != "agent":
            continue
        for t in turns_of.get(id(s), set()):
            assigned.add(t)
    leftover_turns = [t for t in completed_turn_ids if t not in assigned]
    uncovered_agents = [
        s
        for s in segments
        if s.get("role") == "agent"
        and covered.get(id(s)) is False
        and len(turns_of.get(id(s), set())) == 0
        and len(_norm_text(s.get("text"))) > 0  # a row with no real words can't claim a turn
    ]
    for i in range(min(len(leftover_turns), len(uncovered_agents))):
        turns_of.setdefault(id(uncovered_agents[i]), set()).add(leftover_turns[i])

    # Build lookups: which agent rows belong to each turn, and when each
    # customer row started speaking.
    rows_of_turn: dict[int, list[Json]] = {}
    user_rows: list[dict] = []
    row_spoken: dict[int, float] = {}
    for s in segments:
        own = frags_of.get(id(s))
        if own:
            row_spoken[id(s)] = own[0]["spokenTime"]
        turns = turns_of.get(id(s))
        if not turns:
            continue
        if s.get("role") == "agent":
            for t in turns:
                rows_of_turn.setdefault(t, []).append(s)
        elif s.get("role") == "user":
            user_rows.append(
                {"row": s, "minTurn": min(turns), "spoken": row_spoken.get(id(s), 0)}
            )

    # When each turn first produced output, the customer speech that triggered
    # a turn must have started before this moment.
    turn_first_out: dict[int, float] = {}
    for tid in completed_turn_ids:
        for e in by_turn[tid]:
            if e["event"] in ("pipeline.botSpeechStarted", "assistant.tool.started"):
                turn_first_out[tid] = min(turn_first_out.get(tid, math.inf), e["time"])

    # Attach VAPI's latency numbers: entry #i describes completed turn #i.
    for i in range(len(completed_turn_ids)):
        T = completed_turn_ids[i]
        tl: Optional[Json] = turn_latencies[i] if i < len(turn_latencies) else None
        evs = by_turn[T]
        speech_rows = rows_of_turn.get(T, [])

        # STT goes to the customer row that triggered this turn. If one customer
        # row triggered several measured exchanges, keep the largest value, the
        # worst transcription delay that speech experienced.
        if tl is not None and tl.get("transcriberLatency") is not None:
            first_out = turn_first_out.get(T, math.inf)
            trigger = None
            for u in reversed(user_rows):
                if u["minTurn"] <= T and u["spoken"] < first_out:
                    trigger = u["row"]
                    break
            if trigger is not None:
                prev = (trigger.get("metadata") or {}).get("stt_node_ttfb")
                if prev is None or tl["transcriberLatency"] > prev:
                    trigger["metadata"] = {
                        **(trigger.get("metadata") or {}),
                        "stt_node_ttfb": tl["transcriberLatency"],
                    }

        # Latency/LLM/TTS go to the turn's first spoken reply.
        if (
            speech_rows
            and tl is not None
            and "e2e_latency" not in (speech_rows[0].get("metadata") or {})
        ):
            md: Json = {}
            if tl.get("turnLatency") is not None:
                md["e2e_latency"] = tl["turnLatency"]
            if tl.get("modelLatency") is not None:
                md["llm_node_ttft"] = tl["modelLatency"]
            if tl.get("voiceLatency") is not None:
                md["tts_node_ttfb"] = tl["voiceLatency"]
            if md:
                speech_rows[0]["metadata"] = {**(speech_rows[0].get("metadata") or {}), **md}

        # Replies spoken after a tool finished get their own metrics from the log.
        runs = [e for e in evs if e["event"] == "pipeline.botSpeechStarted"]
        for k in range(1, min(len(speech_rows), len(runs))):
            if "e2e_latency" in (speech_rows[k].get("metadata") or {}):
                continue
            run_start = runs[k]["time"]

            def last_before(name: str):
                for e in reversed(evs):
                    if e["event"] == name and e["time"] < run_start:
                        return e
                return None

            llm = last_before("assistant.model.firstTokenReceived")
            tts = last_before("assistant.voice.firstAudioReceived")
            tool = last_before("assistant.tool.completed")
            md = {}
            if tool:
                md["e2e_latency"] = run_start - tool["time"]  # wait after the tool returned
            if llm and llm.get("latency") is not None:
                md["llm_node_ttft"] = llm["latency"]
            if tts and tts.get("latency") is not None:
                md["tts_node_ttfb"] = tts["latency"]
            if md:
                speech_rows[k]["metadata"] = {**(speech_rows[k].get("metadata") or {}), **md}

    # Interruptions: the log marks every barge-in the assistant reacted to.
    # We find which stretch of agent speech the cut landed inside and flag that
    # row. Barge-ins that happened before the agent even spoke have no row to
    # flag, so they are skipped.
    # Time spans when the agent was actually speaking, and which turn each span belongs to.
    intervals: list[dict] = []
    open_iv: Optional[dict] = None
    for e in events:
        if e["event"] == "pipeline.botSpeechStarted":
            if open_iv:
                intervals.append({**open_iv, "end": e["time"]})
            open_iv = {"tid": e["turnId"], "start": e["time"]}
        elif e["event"] == "pipeline.botSpeechStopped" and open_iv:
            intervals.append({**open_iv, "end": e["time"]})
            open_iv = None
    if open_iv:
        intervals.append({**open_iv, "end": math.inf})

    for e in events:
        if e["event"] != "pipeline.cleared" or not e["wasInterruption"]:
            continue
        # Match the LATEST interval containing the cut (with a little slack for
        # event-ordering jitter), when two speech runs are back to back, the cut
        # belongs to the one that was actually playing.
        hit: Optional[dict] = None
        for iv in intervals:
            if iv["start"] <= e["time"] <= iv["end"] + 100:
                hit = iv
        if not hit:
            continue  # pre-speech cancellation: nothing was said, nothing to flag
        rows = rows_of_turn.get(hit["tid"], [])
        if not rows:
            continue
        # The cut row: among the turn's rows belonging to this speech run (spoken
        # after the run started, with slack for transcriber lag), the last one
        # already being spoken at the cut.
        in_run = [r for r in rows if row_spoken.get(id(r), 0) >= hit["start"] - 1000]
        pool = in_run if in_run else rows
        spoken = [r for r in pool if row_spoken.get(id(r), 0) <= e["time"] + 100]
        row = spoken[-1] if spoken else pool[0]
        row["metadata"] = {**(row.get("metadata") or {}), "interrupted": True}

    # VAPI sometimes splits one continuous agent sentence into two rows (when
    # the customer says something brief mid-sentence). The second piece has no
    # measurements of its own, so it would look like an empty row, re-join it
    # with its first half. Only provable same-turn pieces with no metrics of
    # their own are merged; everything else is left untouched.
    for i in range(len(segments) - 1, 0, -1):
        r = segments[i]
        if r.get("role") != "agent":
            continue
        md = r.get("metadata") or {}
        if (
            md.get("e2e_latency") is not None
            or md.get("llm_node_ttft") is not None
            or md.get("tts_node_ttfb") is not None
        ):
            continue  # has its own measurement -> a real, separate utterance
        r_turns = turns_of.get(id(r))
        if not r_turns:
            continue  # unbound -> not provably a slice
        pi = i - 1
        while pi >= 0 and segments[pi].get("role") != "agent":
            pi -= 1
        if pi < 0:
            continue
        p = segments[pi]
        p_turns = turns_of.get(id(p))
        if not p_turns or not all(t in p_turns for t in r_turns):
            continue  # different turn
        if md.get("interrupted") and (p.get("metadata") or {}).get("interrupted"):
            continue  # two distinct cuts -> keep both visible

        p["text"] = f"{p.get('text') or ''} {r.get('text') or ''}".strip()
        r_end = (
            r["end_ms"]
            if isinstance(r.get("end_ms"), (int, float))
            else (
                r["start_ms"] + r["duration_ms"]
                if isinstance(r.get("start_ms"), (int, float))
                and isinstance(r.get("duration_ms"), (int, float))
                else None
            )
        )
        if r_end is not None:
            p["end_ms"] = max(p["end_ms"], r_end) if isinstance(p.get("end_ms"), (int, float)) else r_end
        if isinstance(p.get("start_ms"), (int, float)) and isinstance(p.get("end_ms"), (int, float)):
            p["duration_ms"] = p["end_ms"] - p["start_ms"]
        if isinstance(r.get("words"), list) and r["words"]:
            p["words"] = [*(p.get("words") or []), *r["words"]]
        if md.get("interrupted"):
            p["metadata"] = {**(p.get("metadata") or {}), "interrupted": True}
        del segments[i]
    return True


def _merge_user_slices(segments: list[Json]) -> None:
    """
    Re-join customer sentences that VAPI split into two rows mid-sentence.
    Merged only when clearly one utterance: the rows are back to back with
    essentially no pause, and at most one of them carries an STT value
    (two measured rows are two real utterances and stay separate).
    """
    for i in range(len(segments) - 1, 0, -1):
        r = segments[i]
        p = segments[i - 1]
        if r.get("role") != "user" or p.get("role") != "user":
            continue
        gap = (
            r["start_ms"] - p["end_ms"]
            if isinstance(r.get("start_ms"), (int, float)) and isinstance(p.get("end_ms"), (int, float))
            else math.inf
        )
        if abs(gap) > 1000:
            continue  # not a slice boundary
        r_stt = (r.get("metadata") or {}).get("stt_node_ttfb")
        p_stt = (p.get("metadata") or {}).get("stt_node_ttfb")
        if r_stt is not None and p_stt is not None:
            continue  # two measured utterances

        p["text"] = f"{p.get('text') or ''} {r.get('text') or ''}".strip()
        r_end = (
            r["end_ms"]
            if isinstance(r.get("end_ms"), (int, float))
            else (
                r["start_ms"] + r["duration_ms"]
                if isinstance(r.get("start_ms"), (int, float))
                and isinstance(r.get("duration_ms"), (int, float))
                else None
            )
        )
        if r_end is not None:
            p["end_ms"] = max(p["end_ms"], r_end) if isinstance(p.get("end_ms"), (int, float)) else r_end
        if isinstance(p.get("start_ms"), (int, float)) and isinstance(p.get("end_ms"), (int, float)):
            p["duration_ms"] = p["end_ms"] - p["start_ms"]
        if isinstance(r.get("words"), list) and r["words"]:
            p["words"] = [*(p.get("words") or []), *r["words"]]
        if r_stt is not None and p_stt is None:
            p["metadata"] = {**(p.get("metadata") or {}), "stt_node_ttfb": r_stt}
        if (r.get("metadata") or {}).get("interrupted"):
            p["metadata"] = {**(p.get("metadata") or {}), "interrupted": True}
        del segments[i]


# =============================================================================
# CALL-LEVEL MAPPING, mirrors how Tuner maps VAPI calls natively.
# =============================================================================
# VAPI call types -> Tuner's canonical snake_case values; unknown types pass through.
_VAPI_CALL_TYPE_MAP = {
    "webCall": "web_call",
    "phoneCall": "phone_call",
    "sipCall": "sip_call",
}


def _map_call_type(vapi_type: Any) -> str:
    """Normalize VAPI's camelCase call type to Tuner's snake_case."""
    if not vapi_type:
        return "phone_call"
    return _VAPI_CALL_TYPE_MAP.get(vapi_type, vapi_type)


def _map_analysis(message: Json) -> tuple[Optional[Json], Optional[bool]]:
    """Build Tuner's call_analysis ({summary, success_evaluation}) and call_successful."""
    call_analysis: Json = {}
    call_successful: Optional[bool] = None

    analysis: Json = message.get("analysis") or {}
    if analysis.get("summary"):
        call_analysis["summary"] = analysis["summary"]
    success_eval = analysis.get("successEvaluation")
    if success_eval is not None:
        call_analysis["success_evaluation"] = success_eval
        call_successful = str(success_eval).lower() == "true"

    # Fall back to the top-level summary if analysis didn't carry one.
    if message.get("summary") and "summary" not in call_analysis:
        call_analysis["summary"] = message["summary"]

    return (call_analysis if call_analysis else None), call_successful


def _cost_in_cents(cost: Any) -> Optional[float]:
    """VAPI reports cost in dollars; Tuner expects cents."""
    if not isinstance(cost, (int, float)) or isinstance(cost, bool) or math.isnan(cost):
        return None
    # round half up to 2 decimals, matching JS Math.round semantics
    return math.floor(cost * 100 * 100 + 0.5) / 100


def _strip_none(obj: Any) -> Any:
    """Drop None values recursively so segments only carry fields that exist."""
    if isinstance(obj, list):
        return [_strip_none(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _strip_none(v) for k, v in obj.items() if v is not None}
    return obj


# =============================================================================
# MAPPING, VAPI messages -> Tuner's transcript timeline.
# Mirrors Tuner's internal VAPI mapper so user/agent speech, tool calls, and
# tool results are all captured. VAPI roles map to Tuner roles like so:
#   user  -> user        bot         -> agent
#   tool_calls -> agent_function     tool_call_result -> agent_result
#   system -> dropped
# =============================================================================
def _build_segments(raw_messages: list, call_start_ms: Optional[int]) -> list[Json]:
    segments: list[Json] = []
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


def _speech_segment(m: Json, role: str, call_start_ms: Optional[int]) -> Optional[Json]:
    """
    A spoken row (customer or agent) with its timing. Tuner requires timing on
    every spoken row, so a rare row with no usable timing is skipped rather
    than rejecting the whole call.
    """
    start_ms, end_ms, duration_ms = _segment_timing(m, call_start_ms)
    seg_words = _words(m.get("metadata"), call_start_ms)

    has_timing = start_ms is not None and (end_ms is not None or duration_ms is not None)
    if not has_timing and not seg_words:
        logger.warning(
            f"Tuner: skipping untimed {role} segment: {str(m.get('message') or '')[:50]}"
        )
        return None

    seg: Json = {"role": role, "text": m.get("message")}
    if start_ms is not None:
        seg["start_ms"] = start_ms
    if end_ms is not None:
        seg["end_ms"] = end_ms
    if duration_ms is not None:
        seg["duration_ms"] = duration_ms
    if seg_words:
        seg["words"] = seg_words
    return seg


def _tool_call_segments(m: Json) -> list[Json]:
    """One agent_function segment per tool the agent invoked."""
    seconds = m.get("secondsFromStart")
    start_ms = math.ceil(seconds * 1000) if seconds is not None else None
    out: list[Json] = []
    for tc in m.get("toolCalls") or []:
        if not isinstance(tc, dict):
            continue
        fn: Json = tc.get("function") or {}
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


def _tool_result_segment(m: Json) -> Json:
    """The result returned by a tool. Non-object results are wrapped so nothing is lost."""
    seconds = m.get("secondsFromStart")
    start_ms = math.ceil(seconds * 1000) if seconds is not None else None
    parsed = _maybe_json(m.get("result"))

    if isinstance(parsed, dict):
        result: Optional[Json] = parsed
    elif (isinstance(parsed, list) and parsed) or (isinstance(parsed, str) and parsed):
        result = {"value": parsed}
    else:
        result = None

    is_error, error_msg = _detect_tool_error(m, parsed)
    tool: Json = {
        "name": m.get("name"),
        "request_id": m.get("toolCallId"),
        "result": result,
        "is_error": is_error,
        "start_ms": start_ms,
        "end_ms": start_ms,
    }
    if error_msg:
        tool["error"] = error_msg
    return {"role": "agent_result", "start_ms": start_ms, "end_ms": start_ms, "tool": tool}


def _detect_tool_error(m: Json, parsed: Any) -> tuple[bool, Optional[str]]:
    """
    Detect whether a tool result was an error and extract its message. VAPI has
    no single standard error flag, so the common explicit signals are checked.
    """
    # 1. Explicit flags on the VAPI message (extra fields are allowed by VAPI).
    msg_error = m.get("error")
    if isinstance(msg_error, str) and msg_error:
        return True, msg_error
    if m.get("error") is True or m.get("isError") is True or m.get("is_error") is True:
        return True, (msg_error if isinstance(msg_error, str) else None)
    if m.get("success") is False:
        return True, None

    # 2. Error-shaped result payload, e.g. {"error": "..."} or {"status": "failed"}.
    if isinstance(parsed, dict):
        p = parsed
        if p.get("error"):
            return True, (p["error"] if isinstance(p["error"], str) else None)
        if p.get("success") is False:
            return True, None
        status = p.get("status")
        if isinstance(status, str) and status.lower() in ("error", "failed", "failure"):
            return True, (p["message"] if isinstance(p.get("message"), str) else None)

    return False, None


# =============================================================================
# TURN GROUPING + LATENCY ATTACHMENT (payload-only path)
# =============================================================================
def _group_into_turns(segments: list[Json]) -> list[dict]:
    """
    Group transcript rows into conversation turns: each customer message starts
    a new turn, and everything the agent does until the next customer message
    (speech, tool calls, tool results) belongs to that turn. The opening
    greeting, spoken before any customer speech, has no trigger.
    """
    turns: list[dict] = []
    cur: dict = {"trigger": None, "rows": [], "hasSpeech": False}

    def flush():
        if cur["rows"]:
            turns.append(cur)

    for seg in segments:
        role = seg.get("role")
        if role == "user":
            flush()
            cur = {"trigger": seg, "rows": [], "hasSpeech": False}
        elif role == "agent":
            cur["rows"].append(seg)
            cur["hasSpeech"] = True
        elif role == "agent_function" and cur["hasSpeech"]:
            flush()
            cur = {"trigger": cur["trigger"], "rows": [seg], "hasSpeech": False}
        else:
            cur["rows"].append(seg)  # agent_result, or a tool call opening the turn
    flush()
    return turns


def _enrich_with_turn_latencies(segments: list[Json], turn_latencies: list) -> None:
    """
    Attach VAPI's latency numbers without the call log (fallback path).
    VAPI reports one latency entry per agent response: STT goes to the customer
    row that triggered it, and latency/LLM/TTS go to the agent's reply. The
    opening greeting has no entry. Zeros are real values and are kept.
    """
    # Agent speech before any customer speech (the greeting) never gets an entry.
    eligible = [t for t in _group_into_turns(segments) if t["trigger"] is not None]

    count = min(len(eligible), len(turn_latencies))
    for i in range(count):
        turn = eligible[i]
        tl = turn_latencies[i]

        trigger = turn["trigger"]
        if tl.get("transcriberLatency") is not None:
            prev = (trigger.get("metadata") or {}).get("stt_node_ttfb")
            if prev is None or tl["transcriberLatency"] > prev:
                trigger["metadata"] = {
                    **(trigger.get("metadata") or {}),
                    "stt_node_ttfb": tl["transcriberLatency"],
                }

        speech = next((r for r in turn["rows"] if r.get("role") == "agent"), None)
        if not speech:
            continue  # e.g. an endCall turn with no spoken reply
        metadata: Json = {}
        if tl.get("turnLatency") is not None:
            metadata["e2e_latency"] = tl["turnLatency"]
        if tl.get("modelLatency") is not None:
            metadata["llm_node_ttft"] = tl["modelLatency"]
        if tl.get("voiceLatency") is not None:
            metadata["tts_node_ttfb"] = tl["voiceLatency"]
        if metadata:
            speech["metadata"] = {**(speech.get("metadata") or {}), **metadata}


# A customer turn must start at least this many ms before the agent's turn ends
# to count as a barge-in (filters out word-boundary noise and short backchannels).
_INTERRUPTION_THRESHOLD_MS = 200


def _mark_interruptions(segments: list[Json]) -> None:
    """
    Flag agent rows the customer talked over (fallback path, no call log).
    If a customer message starts clearly before the previous agent message
    ended, that agent message was interrupted. The log-based path detects
    interruptions more completely; this is the best the payload alone allows.
    """
    last_agent_seg: Optional[Json] = None
    for seg in segments:
        role = seg.get("role")
        if role == "agent":
            last_agent_seg = seg
        elif role == "user":
            if (
                last_agent_seg
                and last_agent_seg.get("end_ms") is not None
                and seg.get("start_ms") is not None
                and seg["start_ms"] < last_agent_seg["end_ms"] - _INTERRUPTION_THRESHOLD_MS
            ):
                last_agent_seg["metadata"] = {
                    **(last_agent_seg.get("metadata") or {}),
                    "interrupted": True,
                }
            last_agent_seg = None  # each customer turn compares against a fresh agent turn
        # tool segments: ignore, keep the current agent turn as the candidate


# =============================================================================
# TIMING HELPERS
# =============================================================================
def _segment_timing(m: Json, call_start_ms: Optional[int]):
    """Work out a row's start/end/duration relative to the start of the call."""
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    duration_ms: Optional[int] = None

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


def _words(metadata: Any, call_start_ms: Optional[int]) -> Optional[list[Json]]:
    """
    Word-level timing from VAPI. VAPI has used different time units for word
    timestamps over time, so the unit is detected from the value itself.
    """
    if not isinstance(metadata, dict):
        return None
    raw = metadata.get("wordLevelConfidence")
    if not isinstance(raw, list) or len(raw) == 0:
        return None

    def to_rel_ms(v: float) -> int:
        if v > 1e11:
            return math.ceil(v - (call_start_ms or 0))  # epoch ms
        if v < 1e5:
            return math.ceil(v * 1000)  # seconds from call start
        return math.ceil(v)  # already ms from call start

    out: list[Json] = []
    for w in raw:
        if (
            not isinstance(w, dict)
            or not w.get("word")
            or not isinstance(w.get("start"), (int, float))
            or not isinstance(w.get("end"), (int, float))
        ):
            continue
        out.append(
            {
                "word": w["word"],
                "start_ms": to_rel_ms(w["start"]),
                "end_ms": to_rel_ms(w["end"]),
                "confidence": w.get("confidence"),
            }
        )
    return out or None


def _maybe_json(value: Any) -> Any:
    """VAPI sends tool arguments/results as JSON strings; parse them, else pass through."""
    if not isinstance(value, str):
        return value
    import json

    try:
        return json.loads(value)
    except ValueError:
        return value


def _to_epoch_ms(value: Any) -> Optional[int]:
    """Accept VAPI's ISO string ('2026-06-10T...Z') or a number; return epoch ms."""
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.trunc(value)
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None
