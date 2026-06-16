/**
 * Send your VAPI calls to Tuner
 * ==============================
 * Drop this file next to your VAPI server and call `sendCallToTuner(message)`
 * from inside your `end-of-call-report` handler, that's the whole integration:
 *
 *   sendCallToTuner(message);   // fire-and-forget; never throws
 *
 *   // optional: attach your own metadata object to the call in Tuner
 *   sendCallToTuner(message, { customer_id: "cus_123", campaign: "june-promo" });
 *
 * Every finished call, including its tool calls and tool results, will show
 * up under your Tuner agent.
 *
 * The function automatically downloads VAPI's call log (`artifact.logUrl`,
 * one extra GET, no API key needed) to enrich the call with exact per-turn
 * latencies and interruptions. If the log is missing or unreadable, it falls
 * back to payload-only enrichment by itself, the transcript never depends on
 * the log, and a call is never lost because of it.
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
// CONFIG, fill these in
// =============================================================================
const TUNER_BASE_URL = "https://api.usetuner.ai"; // your Tuner API base URL
const TUNER_API_KEY = "tr_api_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
const TUNER_WORKSPACE = 0; // your workspace id (number)
const TUNER_AGENT_ID = "your-custom-api-agent-id";

// Network timeout & retry behavior for the POST to Tuner.
const REQUEST_TIMEOUT_MS = 15_000; // per-attempt timeout for the POST to Tuner
const MAX_ATTEMPTS = 3; // retry attempts on transient failures (network, 408, 429, 5xx)

type Json = Record<string, any>;

/** VAPI call log: raw JSONL text, or an array of parsed log-line objects. */
type VapiLog = string | Json[];

// =============================================================================
// THE FUNCTION, call this from your end-of-call handler
// =============================================================================
/**
 * Forward one VAPI `end-of-call-report` message to Tuner.
 *
 * `message` is the `body.message` object VAPI posts to your webhook.
 * `metadata` (optional) is a free-form object stored with the call in Tuner
 * (e.g. your own customer id, campaign, A/B variant). Sent only when you
 * provide it; nothing is sent by default.
 *
 * The VAPI call log is fetched internally from `artifact.logUrl`; when that
 * fails, the payload-only enrichment runs instead, fully automatic.
 * Pass `prefetchedLog` when you already downloaded the log (e.g. to save it
 * locally) so it isn't fetched twice.
 * Safe to call inline, it never throws; failures are logged, not thrown.
 */
export async function sendCallToTuner(
  message: Json,
  metadata?: Json | null,
  prefetchedLog?: Json[] | null,
): Promise<void> {
  try {
    const call: Json = message.call ?? {};
    const artifact: Json = message.artifact ?? {};

    const callId = call.id;
    if (!callId) {
      console.warn("Tuner: end-of-call-report has no call id, call will not be sent");
      return;
    }

    // VAPI keeps the timed, structured transcript under artifact.messages.
    const rawMessages: Json[] = artifact.messages ?? message.messages ?? [];
    const callStartMs = toEpochMs(message.startedAt);
    let segments = buildSegments(rawMessages, callStartMs);
    if (segments.length === 0) {
      console.warn(`Tuner: no transcript segments found, call ${callId} will not be sent`);
      return;
    }

    // Fetch VAPI's call log (one GET, no auth). null on any failure -> fallback.
    const log =
      prefetchedLog !== undefined
        ? prefetchedLog
        : await fetchVapiLog(artifact.logUrl ?? message.logUrl);

    // Attach per-turn latency: STT to the customer turn, LLM/TTS/e2e to the agent reply.
    // With a call log: exact interruptions + real metrics on post-tool replies.
    // Without (or if the log doesn't line up): the verified payload-only logic.
    const turnLatencies: Json[] = artifact.performanceMetrics?.turnLatencies ?? [];
    let logEnriched = false;
    if (log) {
      try {
        logEnriched = enrichFromLog(segments, log, turnLatencies);
      } catch (err) {
        logEnriched = false;
        console.warn(
          `Tuner: log enrichment failed for call ${callId} (${String(err)}), using payload-only metrics`,
        );
      }
    }
    if (!logEnriched) {
      if (turnLatencies.length) {
        enrichWithTurnLatencies(segments, turnLatencies);
      }
      // Without log ground truth, deduce barge-ins from timing overlap.
      markInterruptions(segments);
    }
    // Re-join customer utterances that VAPI's stitcher sliced into two rows.
    mergeUserSlices(segments);
    segments = segments.map(stripNull);

    const stereoUrl = message.stereoRecordingUrl ?? artifact.stereoRecordingUrl ?? null;
    const recordingUrl = message.recordingUrl ?? artifact.recordingUrl ?? stereoUrl;
    if (!recordingUrl) {
      console.warn(`Tuner: no recording URL, call ${callId} will not be sent to Tuner`);
      return;
    }

    // Metadata is sent only when the caller provides it; Tuner accepts
    // free-form keys here and stores them with the call. It must be JSON-
    // serializable, anything else is dropped so the call itself still sends.
    let meta: Json | null =
      metadata && typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length
        ? metadata
        : null;
    if (meta) {
      try {
        JSON.stringify(meta);
      } catch {
        console.warn(`Tuner: metadata for call ${callId} is not JSON-serializable, sending without it`);
        meta = null;
      }
    }

    const { callAnalysis, callSuccessful } = mapAnalysis(message);
    // sip_call_id: the SIP Call-ID of the leg that reached VAPI, exposed by
    // VAPI as the "cid" variable (and as sbcCallSid). Tuner stores this same
    // id for its simulation calls, so it links the call back to a simulation
    // run. The correlation-id override variable is a last resort; nulls are
    // dropped below, so regular calls are unaffected.
    const correlationId =
      call.assistantOverrides?.variableValues?.["cid"] ??
      call.transport?.sbcCallSid ??
      call.phoneCallProviderDetails?.sbcCallId ??
      call.assistantOverrides?.variableValues?.["correlation-id"] ??
      null;

    // recipient: the call's destination address.
    const recipient = call.customer?.sipUri ?? call.customer?.number ?? null;
    const payload: Json = {
      call_id: callId,
      sip_call_id: correlationId,
      recipient,
      call_type: mapCallType(call.type),
      start_timestamp: callStartMs,
      end_timestamp: toEpochMs(message.endedAt),
      recording_url: recordingUrl,
      recording_multi_channel_url: stereoUrl,
      transcript: message.transcript ?? artifact.transcript ?? null,
      transcript_with_tool_calls: segments,
      call_status: "call_ended",
      disconnection_reason:
        typeof message.endedReason === "string" ? message.endedReason.slice(0, 100) || null : null,
      caller_phone_number: call.customer?.number ?? null,
      call_successful: callSuccessful,
      call_analysis: callAnalysis,
      call_cost: costInCents(message.cost),
      metadata: meta,
    };
    // Drop empty optional fields so we only send what we actually have.
    for (const key of Object.keys(payload)) {
      if (payload[key] === null || payload[key] === undefined) delete payload[key];
    }

    const params = new URLSearchParams({
      workspace_id: String(TUNER_WORKSPACE),
      agent_remote_identifier: TUNER_AGENT_ID,
    });
    const url = `${TUNER_BASE_URL}/api/v1/public/call?${params}`;
    const body = JSON.stringify(payload);

    // POST with retries. Transient failures (network errors, timeouts, 429,
    // 5xx) get up to 3 attempts with exponential backoff + jitter; other 4xx
    // are real errors that retrying can't fix, so they fail fast. Retrying is
    // safe because ingestion is idempotent: a duplicate call_id returns 409,
    // which counts as success.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let status = 0;
      let detail = "";
      let retryAfterMs = 0;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TUNER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = response.status;
        if (status === 200 || status === 201) {
          console.info(`Tuner: sent call ${callId}${logEnriched ? " (log-enriched)" : ""}`);
          return;
        }
        if (status === 409) {
          console.info(`Tuner: call ${callId} already sent`); // idempotent, fine
          return;
        }
        detail = await response.text().catch(() => "");
        const retryable = status === 408 || status === 429 || status >= 500;
        if (!retryable) {
          console.warn(`Tuner: call ${callId} failed (${status}), not retryable: ${detail}`);
          return;
        }
        const ra = Number(response.headers?.get?.("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 30_000);
      } catch (err) {
        detail = String(err); // network error / timeout -> retryable
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000; // ~2-3s, ~4-5s
        const waitMs = Math.max(backoffMs, retryAfterMs);
        console.warn(
          `Tuner: attempt ${attempt}/${MAX_ATTEMPTS} for call ${callId} failed (${status || "network"}), retrying in ${Math.round(waitMs / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      } else {
        console.warn(
          `Tuner: call ${callId} failed after ${MAX_ATTEMPTS} attempts (${status || "network"}) ${detail}`,
        );
      }
    }
  } catch (err) {
    // never let Tuner break your call handling
    console.warn("Tuner: error sending call:", err);
  }
}

// =============================================================================
// VAPI CALL LOG, internal fetch + log-based enrichment
// =============================================================================
/**
 * Download and parse a VAPI call log (`message.artifact.logUrl`).
 *
 * The log is a gzipped JSONL file on VAPI's storage; no API key is needed.
 * Returns the parsed log lines, or null on any failure (missing URL, timeout,
 * bad response), the caller then falls back to payload-only enrichment.
 */
export async function fetchVapiLog(logUrl: unknown): Promise<Json[] | null> {
  if (typeof logUrl !== "string" || !logUrl) return null;
  try {
    const res = await fetch(logUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(
        `Tuner: could not fetch VAPI call log (HTTP ${res.status}), continuing without log enrichment`,
      );
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());

    let text: string;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      // The log is gzipped, decompress with Node's built-in zlib.
      const zlib = (await import("node:" + "zlib")) as any;
      text = zlib.gunzipSync(buf).toString("utf8");
    } else {
      text = new TextDecoder().decode(buf);
    }

    const out: Json[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return out.length ? out : null;
  } catch (err) {
    console.warn(
      `Tuner: could not read VAPI call log (${String(err)}), continuing without log enrichment`,
    );
    return null;
  }
}

type LogEvent = {
  turnId: number;
  time: number;
  event: string;
  latency: number | null;
  wasInterruption: boolean;
};

/** Pull the per-turn events we use out of the raw log lines. */
function normalizeLogEvents(log: VapiLog): LogEvent[] {
  const lines: Json[] =
    typeof log === "string"
      ? log
          .split("\n")
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter((l): l is Json => l !== null)
      : log;

  const events: LogEvent[] = [];
  for (const line of lines) {
    const a = line?.attributes;
    if (!a || typeof a !== "object") continue;
    const rawTurn = a.turnId;
    // numeric turnIds only; "CLEAN_UP" etc. are not conversation turns
    if (rawTurn === undefined || rawTurn === null || !/^\d+$/.test(String(rawTurn))) continue;
    if (typeof line.time !== "number" || typeof a.event !== "string") continue;
    events.push({
      turnId: Number(rawTurn),
      time: line.time,
      event: a.event,
      latency: typeof a.latency === "number" ? a.latency : null,
      wasInterruption: a.wasInterruption === true,
    });
  }
  events.sort((x, y) => x.time - y.time);
  return events;
}

type LogFragment = {
  channel: string;
  turnId: number | null;
  text: string;
  time: number; // when the final transcript ARRIVED (ordering)
  spokenTime: number; // when the speech was HEARD (first partial of the chain)
};

/**
 * Pull the speech snippets out of the log: who said it, which turn, and when
 * it was actually spoken (taken from the live partial transcripts, which are
 * more reliable than the final transcript's arrival time).
 */
function extractFragments(log: VapiLog): LogFragment[] {
  const lines: Json[] =
    typeof log === "string"
      ? log
          .split("\n")
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter((l): l is Json => l !== null)
      : log;

  const frags: LogFragment[] = [];
  const partialStart: Record<string, number | null> = { user: null, assistant: null };
  for (const line of lines) {
    const a = line?.attributes;
    if (!a || typeof a !== "object") continue;
    const time = typeof line.time === "number" ? line.time : 0;
    const channel = a.channel === "user" ? "user" : "assistant";

    if (a.event === "assistant.transcriber.partialTranscript") {
      if (partialStart[channel] === null) partialStart[channel] = time;
      continue;
    }
    if (a.event !== "assistant.transcriber.finalTranscript") continue;
    if (typeof a.transcript !== "string" || !a.transcript) continue;

    const rawTurn = a.turnId;
    const turnId = rawTurn != null && /^\d+$/.test(String(rawTurn)) ? Number(rawTurn) : null;
    frags.push({
      channel,
      turnId,
      text: a.transcript,
      time,
      spokenTime: partialStart[channel] ?? time,
    });
    partialStart[channel] = null; // next partial starts a new chain
  }
  frags.sort((x, y) => x.time - y.time);
  return frags;
}

/** Lowercase letters and digits only, cosmetic differences can never break matching. */
function normText(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match every transcript row to the log snippets that make up its text.
 * Each VAPI transcript row is the log's speech snippets glued together, so we
 * re-spell the rows from the snippets, each row then knows exactly which
 * snippets (and turns/timings) it is made of. If the texts don't line up,
 * returns null and the simpler enrichment is used instead.
 */
function alignRowsToFragments(
  segments: Json[],
  frags: LogFragment[],
): { fragsOf: Map<Json, LogFragment[]>; covered: Map<Json, boolean> } | null {
  const fragsOf = new Map<Json, LogFragment[]>();
  const covered = new Map<Json, boolean>();

  for (const [channel, role] of [
    ["user", "user"],
    ["assistant", "agent"],
  ] as const) {
    const rows = segments.filter((s) => s.role === role && typeof s.text === "string");
    const fItems = frags
      .filter((f) => f.channel === channel)
      .map((f) => ({ frag: f, text: normText(f.text) }))
      .filter((f) => f.text);
    const rItems = rows.map((r) => ({ row: r, text: normText(r.text) }));

    const bigR = rItems.map((r) => r.text).join("");
    const bigF = fItems.map((f) => f.text).join("");
    if (!bigR.startsWith(bigF)) return null; // real divergence -> don't trust the log

    // Walk both lists; each row consumes fragment characters and collects fragments.
    let fi = 0;
    let fOff = 0;
    for (const { row, text } of rItems) {
      const own: LogFragment[] = [];
      let need = text.length;
      let got = 0;
      while (need > 0 && fi < fItems.length) {
        const f = fItems[fi];
        const take = Math.min(f.text.length - fOff, need);
        own.push(f.frag);
        need -= take;
        got += take;
        fOff += take;
        if (fOff === f.text.length) {
          fi += 1;
          fOff = 0;
        }
      }
      fragsOf.set(row, own);
      covered.set(row, text.length > 0 && got === text.length);
    }
  }
  return { fragsOf, covered };
}

/**
 * Enrich the transcript using VAPI's call log, the most accurate source.
 * The log tells us exactly which latency numbers belong to which rows, the
 * true metrics for replies that follow a tool call, and exactly which agent
 * sentences the customer interrupted.
 *
 * Returns true when applied; false means the log couldn't be used and the
 * simpler payload-based enrichment runs instead.
 */
function enrichFromLog(segments: Json[], log: VapiLog, turnLatencies: Json[]): boolean {
  const events = normalizeLogEvents(log);
  const frags = extractFragments(log);
  if (!events.length || !frags.length) return false;

  // Group events by turn; "completed" turns produced agent output (speech or
  // a tool invocation), these are the turns turnLatencies entries describe.
  const byTurn = new Map<number, LogEvent[]>();
  for (const e of events) {
    const list = byTurn.get(e.turnId) ?? [];
    list.push(e);
    byTurn.set(e.turnId, list);
  }
  const completedTurnIds = [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, evs]) =>
      evs.some((e) => e.event === "pipeline.botSpeechStarted" || e.event === "assistant.tool.started"),
    )
    .map(([tid]) => tid);
  if (!completedTurnIds.length) return false;

  // Bind rows to their fragments by text.
  const aligned = alignRowsToFragments(segments, frags);
  if (!aligned) return false;
  const { fragsOf, covered } = aligned;

  // Figure out which turn produced each piece of agent speech, using WHEN it
  // was spoken vs when each turn started speaking (the log's own turn labels
  // can lag behind for interrupted speech, so timing is the reliable signal).
  const botStarts: { tid: number; time: number }[] = [];
  for (const tid of completedTurnIds) {
    for (const e of byTurn.get(tid)!) {
      if (e.event === "pipeline.botSpeechStarted") botStarts.push({ tid, time: e.time });
    }
  }
  botStarts.sort((a, b) => a.time - b.time);
  const producingTurn = (t: number): number | null => {
    let res: number | null = null;
    for (const b of botStarts) {
      if (b.time <= t) res = b.tid;
      else break;
    }
    return res;
  };

  const turnsOf = new Map<Json, Set<number>>();
  for (const s of segments) {
    const own = fragsOf.get(s);
    if (!own) continue;
    const turns = new Set<number>();
    if (s.role === "agent") {
      for (const f of own) {
        const t = producingTurn(f.spokenTime);
        if (t !== null) turns.add(t);
      }
    } else {
      // User tags are timely: the tag is the turn that started when they spoke.
      for (const f of own) if (f.turnId !== null) turns.add(f.turnId);
    }
    turnsOf.set(s, turns);
  }

  // The final goodbye is often cut off before its transcript finalizes,
  // pair any leftover turns with the remaining unmatched agent rows.
  const assigned = new Set<number>();
  for (const s of segments) {
    if (s.role !== "agent") continue;
    for (const t of turnsOf.get(s) ?? []) assigned.add(t);
  }
  const leftoverTurns = completedTurnIds.filter((t) => !assigned.has(t));
  const uncoveredAgents = segments.filter(
    (s) =>
      s.role === "agent" &&
      covered.get(s) === false &&
      (turnsOf.get(s)?.size ?? 0) === 0 &&
      normText(s.text).length > 0, // a row with no real words can't claim a turn
  );
  for (let i = 0; i < Math.min(leftoverTurns.length, uncoveredAgents.length); i++) {
    turnsOf.get(uncoveredAgents[i])?.add(leftoverTurns[i]);
  }

  // Build lookups: which agent rows belong to each turn, and when each
  // customer row started speaking.
  const rowsOfTurn = new Map<number, Json[]>();
  const userRows: { row: Json; minTurn: number; spoken: number }[] = [];
  const rowSpoken = new Map<Json, number>();
  for (const s of segments) {
    const own = fragsOf.get(s);
    if (own?.length) rowSpoken.set(s, own[0].spokenTime);
    const turns = turnsOf.get(s);
    if (!turns || !turns.size) continue;
    if (s.role === "agent") {
      for (const t of turns) {
        const list = rowsOfTurn.get(t) ?? [];
        list.push(s);
        rowsOfTurn.set(t, list);
      }
    } else if (s.role === "user") {
      userRows.push({ row: s, minTurn: Math.min(...turns), spoken: rowSpoken.get(s) ?? 0 });
    }
  }

  // When each turn first produced output, the customer speech that triggered
  // a turn must have started before this moment.
  const turnFirstOut = new Map<number, number>();
  for (const tid of completedTurnIds) {
    for (const e of byTurn.get(tid)!) {
      if (e.event === "pipeline.botSpeechStarted" || e.event === "assistant.tool.started") {
        turnFirstOut.set(tid, Math.min(turnFirstOut.get(tid) ?? Infinity, e.time));
      }
    }
  }

  // Attach VAPI's latency numbers: entry #i describes completed turn #i.
  for (let i = 0; i < completedTurnIds.length; i++) {
    const T = completedTurnIds[i];
    const tl: Json | undefined = turnLatencies[i];
    const evs = byTurn.get(T)!;
    const speechRows = rowsOfTurn.get(T) ?? [];

    // STT goes to the customer row that triggered this turn. If one customer
    // row triggered several measured exchanges, keep the largest value, the
    // worst transcription delay that speech experienced.
    if (tl?.transcriberLatency != null) {
      const firstOut = turnFirstOut.get(T) ?? Infinity;
      const trigger = [...userRows]
        .reverse()
        .find((u) => u.minTurn <= T && u.spoken < firstOut)?.row;
      if (trigger) {
        const prev = trigger.metadata?.stt_node_ttfb;
        if (prev === undefined || tl.transcriberLatency > prev) {
          trigger.metadata = { ...(trigger.metadata ?? {}), stt_node_ttfb: tl.transcriberLatency };
        }
      }
    }

    // Latency/LLM/TTS go to the turn's first spoken reply.
    if (speechRows[0] && tl && speechRows[0].metadata?.e2e_latency === undefined) {
      const md: Json = {};
      if (tl.turnLatency != null) md.e2e_latency = tl.turnLatency;
      if (tl.modelLatency != null) md.llm_node_ttft = tl.modelLatency;
      if (tl.voiceLatency != null) md.tts_node_ttfb = tl.voiceLatency;
      if (Object.keys(md).length) speechRows[0].metadata = { ...(speechRows[0].metadata ?? {}), ...md };
    }

    // Replies spoken after a tool finished get their own metrics from the log.
    const runs = evs.filter((e) => e.event === "pipeline.botSpeechStarted");
    for (let k = 1; k < Math.min(speechRows.length, runs.length); k++) {
      if (speechRows[k].metadata?.e2e_latency !== undefined) continue;
      const runStart = runs[k].time;
      const lastBefore = (name: string) =>
        [...evs].reverse().find((e) => e.event === name && e.time < runStart);
      const llm = lastBefore("assistant.model.firstTokenReceived");
      const tts = lastBefore("assistant.voice.firstAudioReceived");
      const tool = lastBefore("assistant.tool.completed");
      const md: Json = {};
      if (tool) md.e2e_latency = runStart - tool.time; // wait after the tool returned
      if (llm?.latency != null) md.llm_node_ttft = llm.latency;
      if (tts?.latency != null) md.tts_node_ttfb = tts.latency;
      if (Object.keys(md).length) speechRows[k].metadata = { ...(speechRows[k].metadata ?? {}), ...md };
    }

  }

  // Interruptions: the log marks every barge-in the assistant reacted to.
  // We find which stretch of agent speech the cut landed inside and flag that
  // row. Barge-ins that happened before the agent even spoke have no row to
  // flag, so they are skipped.
  // Time spans when the agent was actually speaking, and which turn each span belongs to.
  const intervals: { tid: number; start: number; end: number }[] = [];
  let open: { tid: number; start: number } | null = null;
  for (const e of events) {
    if (e.event === "pipeline.botSpeechStarted") {
      if (open) intervals.push({ ...open, end: e.time });
      open = { tid: e.turnId, start: e.time };
    } else if (e.event === "pipeline.botSpeechStopped" && open) {
      intervals.push({ ...open, end: e.time });
      open = null;
    }
  }
  if (open) intervals.push({ ...open, end: Infinity });

  for (const e of events) {
    if (e.event !== "pipeline.cleared" || !e.wasInterruption) continue;
    // Match the LATEST interval containing the cut (with a little slack for
    // event-ordering jitter), when two speech runs are back to back, the cut
    // belongs to the one that was actually playing.
    let hit: { tid: number; start: number; end: number } | null = null;
    for (const iv of intervals) {
      if (iv.start <= e.time && e.time <= iv.end + 100) hit = iv;
    }
    if (!hit) continue; // pre-speech cancellation: nothing was said, nothing to flag
    const rows = rowsOfTurn.get(hit.tid) ?? [];
    if (!rows.length) continue;
    // The cut row: among the turn's rows belonging to this speech run (spoken
    // after the run started, with slack for transcriber lag), the last one
    // already being spoken at the cut.
    const inRun = rows.filter((r) => (rowSpoken.get(r) ?? 0) >= hit.start - 1000);
    const pool = inRun.length ? inRun : rows;
    const spoken = pool.filter((r) => (rowSpoken.get(r) ?? 0) <= e.time + 100);
    const row = spoken[spoken.length - 1] ?? pool[0];
    row.metadata = { ...(row.metadata ?? {}), interrupted: true };
  }

  // VAPI sometimes splits one continuous agent sentence into two rows (when
  // the customer says something brief mid-sentence). The second piece has no
  // measurements of its own, so it would look like an empty row, re-join it
  // with its first half. Only provable same-turn pieces with no metrics of
  // their own are merged; everything else is left untouched.
  for (let i = segments.length - 1; i > 0; i--) {
    const r = segments[i];
    if (r.role !== "agent") continue;
    const md = r.metadata ?? {};
    if (md.e2e_latency !== undefined || md.llm_node_ttft !== undefined || md.tts_node_ttfb !== undefined) {
      continue; // has its own measurement -> a real, separate utterance
    }
    const rTurns = turnsOf.get(r);
    if (!rTurns || !rTurns.size) continue; // unbound -> not provably a slice
    let pi = i - 1;
    while (pi >= 0 && segments[pi].role !== "agent") pi--;
    if (pi < 0) continue;
    const p = segments[pi];
    const pTurns = turnsOf.get(p);
    if (!pTurns || ![...rTurns].every((t) => pTurns.has(t))) continue; // different turn
    if (md.interrupted && p.metadata?.interrupted) continue; // two distinct cuts -> keep both visible

    p.text = `${p.text ?? ""} ${r.text ?? ""}`.trim();
    const rEnd =
      typeof r.end_ms === "number"
        ? r.end_ms
        : typeof r.start_ms === "number" && typeof r.duration_ms === "number"
          ? r.start_ms + r.duration_ms
          : null;
    if (rEnd !== null) {
      p.end_ms = typeof p.end_ms === "number" ? Math.max(p.end_ms, rEnd) : rEnd;
    }
    if (typeof p.start_ms === "number" && typeof p.end_ms === "number") {
      p.duration_ms = p.end_ms - p.start_ms;
    }
    if (Array.isArray(r.words) && r.words.length) p.words = [...(p.words ?? []), ...r.words];
    if (md.interrupted) p.metadata = { ...(p.metadata ?? {}), interrupted: true };
    segments.splice(i, 1);
  }
  return true;
}

/**
 * Re-join customer sentences that VAPI split into two rows mid-sentence.
 * Merged only when clearly one utterance: the rows are back to back with
 * essentially no pause, and at most one of them carries an STT value
 * (two measured rows are two real utterances and stay separate).
 */
function mergeUserSlices(segments: Json[]): void {
  for (let i = segments.length - 1; i > 0; i--) {
    const r = segments[i];
    const p = segments[i - 1];
    if (r.role !== "user" || p.role !== "user") continue;
    const gap =
      typeof r.start_ms === "number" && typeof p.end_ms === "number"
        ? r.start_ms - p.end_ms
        : Infinity;
    if (Math.abs(gap) > 1000) continue; // not a slice boundary
    const rStt = r.metadata?.stt_node_ttfb;
    const pStt = p.metadata?.stt_node_ttfb;
    if (rStt !== undefined && pStt !== undefined) continue; // two measured utterances

    p.text = `${p.text ?? ""} ${r.text ?? ""}`.trim();
    const rEnd =
      typeof r.end_ms === "number"
        ? r.end_ms
        : typeof r.start_ms === "number" && typeof r.duration_ms === "number"
          ? r.start_ms + r.duration_ms
          : null;
    if (rEnd !== null) {
      p.end_ms = typeof p.end_ms === "number" ? Math.max(p.end_ms, rEnd) : rEnd;
    }
    if (typeof p.start_ms === "number" && typeof p.end_ms === "number") {
      p.duration_ms = p.end_ms - p.start_ms;
    }
    if (Array.isArray(r.words) && r.words.length) p.words = [...(p.words ?? []), ...r.words];
    if (rStt !== undefined && pStt === undefined) {
      p.metadata = { ...(p.metadata ?? {}), stt_node_ttfb: rStt };
    }
    if (r.metadata?.interrupted) p.metadata = { ...(p.metadata ?? {}), interrupted: true };
    segments.splice(i, 1);
  }
}

// =============================================================================
// CALL-LEVEL MAPPING, mirrors how Tuner maps VAPI calls natively.
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
// MAPPING, VAPI messages -> Tuner's transcript timeline.
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
 * A spoken row (customer or agent) with its timing. Tuner requires timing on
 * every spoken row, so a rare row with no usable timing is skipped rather
 * than rejecting the whole call.
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
    if (tc == null || typeof tc !== "object") continue;
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
 * Detect whether a tool result was an error and extract its message. VAPI has
 * no single standard error flag, so the common explicit signals are checked.
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

// =============================================================================
// TURN GROUPING + LATENCY ATTACHMENT (payload-only path)
// =============================================================================
type Turn = { trigger: Json | null; rows: Json[]; hasSpeech: boolean };

/**
 * Group transcript rows into conversation turns: each customer message starts
 * a new turn, and everything the agent does until the next customer message
 * (speech, tool calls, tool results) belongs to that turn. The opening
 * greeting, spoken before any customer speech, has no trigger.
 */
function groupIntoTurns(segments: Json[]): Turn[] {
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
  return turns;
}

/**
 * Attach VAPI's latency numbers without the call log (fallback path).
 * VAPI reports one latency entry per agent response: STT goes to the customer
 * row that triggered it, and latency/LLM/TTS go to the agent's reply. The
 * opening greeting has no entry. Zeros are real values and are kept.
 */
function enrichWithTurnLatencies(segments: Json[], turnLatencies: Json[]): void {
  // Agent speech before any customer speech (the greeting) never gets an entry.
  const eligible = groupIntoTurns(segments).filter((t) => t.trigger !== null);

  const count = Math.min(eligible.length, turnLatencies.length);
  for (let i = 0; i < count; i++) {
    const turn = eligible[i];
    const tl = turnLatencies[i];

    const trigger = turn.trigger!;
    if (tl.transcriberLatency != null) {
      const prev = trigger.metadata?.stt_node_ttfb;
      if (prev === undefined || tl.transcriberLatency > prev) {
        trigger.metadata = { ...(trigger.metadata ?? {}), stt_node_ttfb: tl.transcriberLatency };
      }
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
 * Flag agent rows the customer talked over (fallback path, no call log).
 * If a customer message starts clearly before the previous agent message
 * ended, that agent message was interrupted. The log-based path detects
 * interruptions more completely; this is the best the payload alone allows.
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
/** Work out a row's start/end/duration relative to the start of the call. */
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
 * Word-level timing from VAPI. VAPI has used different time units for word
 * timestamps over time, so the unit is detected from the value itself.
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