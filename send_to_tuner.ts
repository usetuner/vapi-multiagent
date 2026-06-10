/**
 * Send your VAPI calls to Tuner
 * ==============================
 * Drop this file next to your VAPI server and call `sendCallToTuner(message)`
 * from inside your `end-of-call-report` handler. Every finished call — including
 * its tool calls and tool results — will show up under your Tuner agent.
 *
 * Setup (4 values, all from the Tuner dashboard):
 *   1. TUNER_BASE_URL   -> your Tuner API base URL
 *   2. TUNER_API_KEY    -> Workspace Settings > API Keys           (starts with "tr_api_")
 *   3. TUNER_WORKSPACE  -> Workspace > General Settings
 *   4. TUNER_AGENT_ID   -> create a "Custom API" agent in Tuner, then
 *                          Agent Settings > Agent Connection > Agent ID
 *
 * Requirements: Node 18+ (uses the built-in fetch). No npm dependencies.
 */

// =============================================================================
// CONFIG — fill these in
// =============================================================================
const TUNER_BASE_URL = "https://api.usetuner.ai"; // your Tuner API base URL
const TUNER_API_KEY = "tr_api_f479e62c-0798-4515-993d-556b46bc8b64";
const TUNER_WORKSPACE = 1420; // your workspace id (number)
const TUNER_AGENT_ID = "fa4da74c-f775-4d20-897f-887b7274b067";


type Json = Record<string, any>;

// =============================================================================
// THE FUNCTION — call this from your end-of-call handler
// =============================================================================
/**
 * Forward one VAPI `end-of-call-report` message to Tuner.
 *
 * `message` is the `body.message` object VAPI posts to your webhook.
 * Safe to call inline — it never throws; failures are logged, not thrown.
 */
export async function sendCallToTuner(message: Json): Promise<void> {
  try {
    const call: Json = message.call ?? {};
    const artifact: Json = message.artifact ?? {};

    const callId = call.id;
    if (!callId) {
      console.warn("Tuner: end-of-call-report has no call id — call will not be sent");
      return;
    }

    // VAPI keeps the timed, structured transcript under artifact.messages.
    const rawMessages: Json[] = artifact.messages ?? message.messages ?? [];
    const callStartMs = toEpochMs(message.startedAt);
    let segments = buildSegments(rawMessages, callStartMs);
    if (segments.length === 0) {
      console.warn(`Tuner: no transcript segments found — call ${callId} will not be sent`);
      return;
    }

    // Attach per-turn latency: STT to the customer turn, LLM/TTS/e2e to the agent reply.
    const turnLatencies = artifact.performanceMetrics?.turnLatencies;
    if (turnLatencies?.length) {
      enrichWithTurnLatencies(segments, turnLatencies);
    }
    // Flag agent turns the customer talked over (barge-in).
    markInterruptions(segments);
    segments = segments.map(stripNull);

    const stereoUrl = message.stereoRecordingUrl ?? artifact.stereoRecordingUrl ?? null;
    const recordingUrl = message.recordingUrl ?? artifact.recordingUrl ?? stereoUrl;
    if (!recordingUrl) {
      console.warn(`Tuner: no recording URL — call ${callId} will not be sent to Tuner`);
      return;
    }

    const { callAnalysis, callSuccessful } = mapAnalysis(message);
    const payload: Json = {
      call_id: callId,
      call_type: mapCallType(call.type),
      start_timestamp: callStartMs,
      end_timestamp: toEpochMs(message.endedAt),
      recording_url: recordingUrl,
      recording_multi_channel_url: stereoUrl,
      transcript: message.transcript ?? artifact.transcript ?? null,
      transcript_with_tool_calls: segments,
      call_status: "call_ended",
      disconnection_reason: (message.endedReason ?? "").slice(0, 100) || null,
      caller_phone_number: call.customer?.number ?? null,
      call_successful: callSuccessful,
      call_analysis: callAnalysis,
      call_cost: costInCents(message.cost),
    };
    // Drop empty optional fields so we only send what we actually have.
    for (const key of Object.keys(payload)) {
      if (payload[key] === null || payload[key] === undefined) delete payload[key];
    }

    const params = new URLSearchParams({
      workspace_id: String(TUNER_WORKSPACE),
      agent_remote_identifier: TUNER_AGENT_ID,
    });
    const response = await fetch(`${TUNER_BASE_URL}/api/v1/public/call?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TUNER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 200 || response.status === 201) {
      console.info(`Tuner: sent call ${callId}`);
    } else if (response.status === 409) {
      console.info(`Tuner: call ${callId} already sent`); // idempotent, fine
    } else {
      console.error(`Tuner: failed (${response.status}) ${await response.text()}`);
    }
  } catch (err) {
    // never let Tuner break your call handling
    console.error("Tuner: error sending call:", err);
  }
}

// =============================================================================
// CALL-LEVEL MAPPING — mirrors how Tuner maps VAPI calls natively.
// =============================================================================
// VAPI call types -> Tuner's canonical snake_case values; unknown types pass through.
const VAPI_CALL_TYPE_MAP: Record<string, string> = {
  webCall: "web_call",
  phoneCall: "phone_call",
  sipCall: "sip_call",
};

/** Normalize VAPI's camelCase call type to Tuner's snake_case. */
function mapCallType(vapiType: string | undefined | null): string {
  if (!vapiType) return "phone_call";
  return VAPI_CALL_TYPE_MAP[vapiType] ?? vapiType;
}

/** Build Tuner's call_analysis ({summary, success_evaluation}) and call_successful. */
function mapAnalysis(message: Json): { callAnalysis: Json | null; callSuccessful: boolean | null } {
  const callAnalysis: Json = {};
  let callSuccessful: boolean | null = null;

  const analysis: Json = message.analysis ?? {};
  if (analysis.summary) {
    callAnalysis.summary = analysis.summary;
  }
  const successEval = analysis.successEvaluation;
  if (successEval !== undefined && successEval !== null) {
    callAnalysis.success_evaluation = successEval;
    callSuccessful = String(successEval).toLowerCase() === "true";
  }

  // Fall back to the top-level summary if analysis didn't carry one.
  if (message.summary && !("summary" in callAnalysis)) {
    callAnalysis.summary = message.summary;
  }

  return {
    callAnalysis: Object.keys(callAnalysis).length ? callAnalysis : null,
    callSuccessful,
  };
}

/** VAPI reports cost in dollars; Tuner expects cents. */
function costInCents(cost: unknown): number | null {
  if (typeof cost !== "number" || Number.isNaN(cost)) return null;
  return Math.round(cost * 100 * 100) / 100; // round to 2 decimals
}

/** Drop null/undefined values recursively so segments only carry fields that exist. */
function stripNull<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map(stripNull) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) out[k] = stripNull(v);
    }
    return out as T;
  }
  return obj;
}

// =============================================================================
// MAPPING — VAPI messages -> Tuner's transcript timeline.
// Mirrors Tuner's internal VAPI mapper so user/agent speech, tool calls, and
// tool results are all captured. VAPI roles map to Tuner roles like so:
//   user  -> user        bot         -> agent
//   tool_calls -> agent_function     tool_call_result -> agent_result
//   system -> dropped
// =============================================================================
function buildSegments(rawMessages: Json[], callStartMs: number | null): Json[] {
  const segments: Json[] = [];
  for (const m of rawMessages) {
    if (typeof m !== "object" || m === null) continue;
    const role = m.role;
    if (role === "user") {
      const seg = speechSegment(m, "user", callStartMs);
      if (seg) segments.push(seg);
    } else if (role === "bot" || role === "assistant") {
      const seg = speechSegment(m, "agent", callStartMs);
      if (seg) segments.push(seg);
    } else if (role === "tool_calls") {
      segments.push(...toolCallSegments(m));
    } else if (role === "tool_call_result") {
      segments.push(toolResultSegment(m));
    }
    // "system" and anything else is intentionally skipped.
  }
  return segments;
}

/**
 * A user or agent spoken turn, with timing (and word-level timing if present).
 *
 * Tuner requires timing on every spoken turn. A segment with no resolvable timing
 * would reject the whole call, so we skip it instead — same as Tuner does natively.
 */
function speechSegment(m: Json, role: string, callStartMs: number | null): Json | null {
  const { startMs, endMs, durationMs } = segmentTiming(m, callStartMs);
  const segWords = words(m.metadata, callStartMs);

  const hasTiming = startMs !== null && (endMs !== null || durationMs !== null);
  if (!hasTiming && !segWords) {
    console.warn(`Tuner: skipping untimed ${role} segment: ${String(m.message ?? "").slice(0, 50)}`);
    return null;
  }

  const seg: Json = { role, text: m.message };
  if (startMs !== null) seg.start_ms = startMs;
  if (endMs !== null) seg.end_ms = endMs;
  if (durationMs !== null) seg.duration_ms = durationMs;
  if (segWords) seg.words = segWords;
  return seg;
}

/** One agent_function segment per tool the agent invoked. */
function toolCallSegments(m: Json): Json[] {
  const seconds = m.secondsFromStart;
  const startMs = seconds !== undefined && seconds !== null ? Math.ceil(seconds * 1000) : null;
  const out: Json[] = [];
  for (const tc of m.toolCalls ?? []) {
    const fn: Json = tc.function ?? {};
    const params = maybeJson(fn.arguments);
    out.push({
      role: "agent_function",
      start_ms: startMs,
      end_ms: startMs,
      tool: {
        name: fn.name,
        request_id: tc.id,
        params: typeof params === "object" && params !== null && !Array.isArray(params) ? params : null,
        start_ms: startMs,
        end_ms: startMs,
      },
    });
  }
  return out;
}

/** The result returned by a tool. Non-object results are wrapped so nothing is lost. */
function toolResultSegment(m: Json): Json {
  const seconds = m.secondsFromStart;
  const startMs = seconds !== undefined && seconds !== null ? Math.ceil(seconds * 1000) : null;
  const parsed = maybeJson(m.result);

  let result: Json | null;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    result = parsed;
  } else if ((Array.isArray(parsed) && parsed.length) || (typeof parsed === "string" && parsed)) {
    result = { value: parsed };
  } else {
    result = null;
  }

  const { isError, errorMsg } = detectToolError(m, parsed);
  const tool: Json = {
    name: m.name,
    request_id: m.toolCallId,
    result,
    is_error: isError,
    start_ms: startMs,
    end_ms: startMs,
  };
  if (errorMsg) tool.error = errorMsg;
  return { role: "agent_result", start_ms: startMs, end_ms: startMs, tool };
}

/**
 * Detect whether a tool result represents an error, and extract its message.
 *
 * VAPI has no single standard error flag, so we check the explicit signals that
 * show up in practice — an error field on the message itself, or an error-shaped
 * result payload — rather than guessing from free text.
 */
function detectToolError(m: Json, parsed: unknown): { isError: boolean; errorMsg: string | null } {
  // 1. Explicit flags on the VAPI message (extra fields are allowed by VAPI).
  const msgError = m.error;
  if (typeof msgError === "string" && msgError) {
    return { isError: true, errorMsg: msgError };
  }
  if (m.error === true || m.isError === true || m.is_error === true) {
    return { isError: true, errorMsg: typeof msgError === "string" ? msgError : null };
  }
  if (m.success === false) {
    return { isError: true, errorMsg: null };
  }

  // 2. Error-shaped result payload, e.g. {"error": "..."} or {"status": "failed"}.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const p = parsed as Json;
    if (p.error) {
      return { isError: true, errorMsg: typeof p.error === "string" ? p.error : null };
    }
    if (p.success === false) {
      return { isError: true, errorMsg: null };
    }
    const status = p.status;
    if (typeof status === "string" && ["error", "failed", "failure"].includes(status.toLowerCase())) {
      return { isError: true, errorMsg: typeof p.message === "string" ? p.message : null };
    }
  }

  return { isError: false, errorMsg: null };
}

/**
 * Attach VAPI's turnLatencies to the right rows.
 *
 * VAPI emits ONE turnLatencies entry per completed agent response turn, and a
 * turn can span several messages. The grouping below was verified against
 * VAPI's internal call logs (every log event carries a turnId):
 *  - The canned firstMessage greeting gets NO entry.
 *  - A turn = one run of agent activity triggered by customer speech.
 *  - A tool call that follows agent speech in the same run starts a NEW turn
 *    (it is a fresh model decision). A tool call with no agent speech before
 *    it belongs to the current turn — its filler speech ("Give me a moment"),
 *    the tool result, and the post-result reply all stay in that same turn.
 *  - On tool-call turns VAPI reports modelLatency/voiceLatency as 0.
 *
 * Per entry: stt -> the customer row that triggered the turn (first turn wins
 * when one customer row triggered two turns); llm/tts/e2e -> the turn's first
 * agent speech row. Continuation rows stay badge-less. Zeros are kept.
 */
function enrichWithTurnLatencies(segments: Json[], turnLatencies: Json[]): void {
  // --- group rows into turns ---
  type Turn = { trigger: Json | null; rows: Json[]; hasSpeech: boolean };
  const turns: Turn[] = [];
  let cur: Turn = { trigger: null, rows: [], hasSpeech: false };
  const flush = () => {
    if (cur.rows.length) turns.push(cur);
  };
  for (const seg of segments) {
    if (seg.role === "user") {
      flush();
      cur = { trigger: seg, rows: [], hasSpeech: false };
    } else if (seg.role === "agent") {
      cur.rows.push(seg);
      cur.hasSpeech = true;
    } else if (seg.role === "agent_function" && cur.hasSpeech) {
      flush();
      cur = { trigger: cur.trigger, rows: [seg], hasSpeech: false };
    } else {
      cur.rows.push(seg); // agent_result, or a tool call opening the turn
    }
  }
  flush();

  // Agent speech before any customer speech (the greeting) never gets an entry.
  const eligible = turns.filter((t) => t.trigger !== null);

  const count = Math.min(eligible.length, turnLatencies.length);
  for (let i = 0; i < count; i++) {
    const turn = eligible[i];
    const tl = turnLatencies[i];

    const trigger = turn.trigger!;
    if (tl.transcriberLatency != null && trigger.metadata?.stt_node_ttfb === undefined) {
      trigger.metadata = { ...(trigger.metadata ?? {}), stt_node_ttfb: tl.transcriberLatency };
    }

    const speech = turn.rows.find((r) => r.role === "agent");
    if (!speech) continue; // e.g. an endCall turn with no spoken reply
    const metadata: Json = {};
    if (tl.turnLatency != null) metadata.e2e_latency = tl.turnLatency;
    if (tl.modelLatency != null) metadata.llm_node_ttft = tl.modelLatency;
    if (tl.voiceLatency != null) metadata.tts_node_ttfb = tl.voiceLatency;
    if (Object.keys(metadata).length) speech.metadata = { ...(speech.metadata ?? {}), ...metadata };
  }
}

// A customer turn must start at least this many ms before the agent's turn ends
// to count as a barge-in (filters out word-boundary noise and short backchannels).
const INTERRUPTION_THRESHOLD_MS = 200;

/**
 * Flag agent turns the customer talked over.
 *
 * A barge-in is the customer starting to speak before the agent finished. We
 * compare each customer turn against the agent turn right before it; if it
 * starts before that agent turn ended (beyond a small threshold), the agent was
 * interrupted. The flag is stamped on the AGENT segment that got cut off.
 */
function markInterruptions(segments: Json[]): void {
  let lastAgentSeg: Json | null = null;
  for (const seg of segments) {
    if (seg.role === "agent") {
      lastAgentSeg = seg;
    } else if (seg.role === "user") {
      if (
        lastAgentSeg &&
        lastAgentSeg.end_ms != null &&
        seg.start_ms != null &&
        seg.start_ms < lastAgentSeg.end_ms - INTERRUPTION_THRESHOLD_MS
      ) {
        lastAgentSeg.metadata = { ...(lastAgentSeg.metadata ?? {}), interrupted: true };
      }
      lastAgentSeg = null; // each customer turn compares against a fresh agent turn
    }
    // tool segments: ignore, keep the current agent turn as the candidate
  }
}

// =============================================================================
// TIMING HELPERS
// =============================================================================
/**
 * Resolve (start_ms, end_ms, duration_ms) relative to call start.
 *
 * Prefer secondsFromStart (already relative to call start). Fall back to the
 * absolute epoch `time`/`endTime` fields when call start is known.
 */
function segmentTiming(
  m: Json,
  callStartMs: number | null,
): { startMs: number | null; endMs: number | null; durationMs: number | null } {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let durationMs: number | null = null;

  const seconds = m.secondsFromStart;
  if (seconds !== undefined && seconds !== null) {
    startMs = Math.ceil(seconds * 1000);
  }
  if (m.duration !== undefined && m.duration !== null) {
    durationMs = Math.ceil(m.duration);
  }

  if (startMs !== null && durationMs !== null) {
    endMs = startMs + durationMs;
  } else if (callStartMs !== null) {
    if (m.time !== undefined && m.time !== null && startMs === null) {
      startMs = Math.ceil(m.time - callStartMs);
    }
    if (m.endTime !== undefined && m.endTime !== null) {
      endMs = Math.ceil(m.endTime - callStartMs);
    }
    if (startMs !== null && endMs !== null) {
      durationMs = endMs - startMs;
    }
  }
  return { startMs, endMs, durationMs };
}

/**
 * Word-level timing from VAPI's wordLevelConfidence.
 *
 * VAPI has shipped word start/end in two formats: seconds from call start
 * (current payloads, e.g. 5.98) and epoch milliseconds (older payloads,
 * e.g. 1774621268400). Detect the unit by magnitude so neither produces
 * garbage timestamps.
 */
function words(metadata: unknown, callStartMs: number | null): Json[] | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const raw = (metadata as Json).wordLevelConfidence;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const toRelMs = (v: number): number => {
    if (v > 1e11) return Math.ceil(v - (callStartMs ?? 0)); // epoch ms
    if (v < 1e5) return Math.ceil(v * 1000); // seconds from call start
    return Math.ceil(v); // already ms from call start
  };

  const out: Json[] = [];
  for (const w of raw) {
    if (typeof w !== "object" || w === null || !w.word || typeof w.start !== "number" || typeof w.end !== "number") {
      continue;
    }
    out.push({
      word: w.word,
      start_ms: toRelMs(w.start),
      end_ms: toRelMs(w.end),
      confidence: w.confidence ?? null,
    });
  }
  return out.length ? out : null;
}

/** VAPI sends tool arguments/results as JSON strings; parse them, else pass through. */
function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Accept VAPI's ISO string ('2026-06-10T...Z') or a number; return epoch ms. */
function toEpochMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Math.trunc(value);
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}
