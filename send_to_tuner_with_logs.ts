/**
 * Send your VAPI calls to Tuner
 * ==============================
 * Drop this file next to your VAPI server and call `sendCallToTuner(message)`
 * from inside your `end-of-call-report` handler — that's the whole integration:
 *
 *   sendCallToTuner(message);   // fire-and-forget; never throws
 *
 *   // optional: attach your own metadata object to the call in Tuner
 *   sendCallToTuner(message, { customer_id: "cus_123", campaign: "june-promo" });
 *
 * Every finished call — including its tool calls and tool results — will show
 * up under your Tuner agent. The call's metadata always includes the system
 * prompt the assistant ran with (`customizable_prompt`) — with per-call
 * provisioned agents every call's prompt is unique and worth keeping — plus
 * whatever keys you pass (your keys win on collision).
 *
 * The function automatically downloads VAPI's call log (`artifact.logUrl`,
 * one extra GET, no API key needed) to enrich the call with exact per-turn
 * latencies and interruptions. If the log is missing or unreadable, it falls
 * back to payload-only enrichment by itself — the transcript never depends on
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
// CONFIG — fill these in
// =============================================================================
const TUNER_BASE_URL = "https://api.usetuner.ai"; // your Tuner API base URL
const TUNER_API_KEY = "tr_api_5d64e9c3-c52d-4136-860a-d594aa92a3bc";
const TUNER_WORKSPACE = 10; // your workspace id (number)
const TUNER_AGENT_ID = "faac4803-5fa3-4566-a9d8-2711c866ef73";

type Json = Record<string, any>;

/** VAPI call log: raw JSONL text, or an array of parsed log-line objects. */
type VapiLog = string | Json[];

// =============================================================================
// THE FUNCTION — call this from your end-of-call handler
// =============================================================================
/**
 * Forward one VAPI `end-of-call-report` message to Tuner.
 *
 * `message` is the `body.message` object VAPI posts to your webhook.
 * `metadata` (optional) is a free-form object stored with the call in Tuner
 * (e.g. your own customer id, campaign, A/B variant). It is merged on top of
 * the default `{ customizable_prompt: <the call's system prompt> }` — so the
 * prompt is always kept, and your keys win on collision.
 *
 * The VAPI call log is fetched internally from `artifact.logUrl`; when that
 * fails, the payload-only enrichment runs instead — fully automatic.
 * Safe to call inline — it never throws; failures are logged, not thrown.
 */
export async function sendCallToTuner(message: Json, metadata?: Json | null): Promise<void> {
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

    // Fetch VAPI's call log (one GET, no auth). null on any failure -> fallback.
    const log = await fetchVapiLog(artifact.logUrl ?? message.logUrl);

    // Attach per-turn latency: STT to the customer turn, LLM/TTS/e2e to the agent reply.
    // With a call log: exact interruptions + real metrics on post-tool replies.
    // Without (or if the log doesn't line up): the verified payload-only logic.
    const turnLatencies: Json[] = artifact.performanceMetrics?.turnLatencies ?? [];
    let logEnriched = false;
    if (log) {
      try {
        logEnriched = enrichFromLog(segments, log, turnLatencies);
      } catch {
        logEnriched = false;
      }
    }
    if (!logEnriched) {
      if (turnLatencies.length) {
        enrichWithTurnLatencies(segments, turnLatencies);
      }
      // Without log ground truth, deduce barge-ins from timing overlap.
      markInterruptions(segments);
    }
    segments = segments.map(stripNull);

    const stereoUrl = message.stereoRecordingUrl ?? artifact.stereoRecordingUrl ?? null;
    const recordingUrl = message.recordingUrl ?? artifact.recordingUrl ?? stereoUrl;
    if (!recordingUrl) {
      console.warn(`Tuner: no recording URL — call ${callId} will not be sent to Tuner`);
      return;
    }

    // Metadata always carries the call's system prompt (customizable_prompt),
    // plus any keys the caller passed — caller keys win on collision. Tuner
    // accepts free-form keys here and stores them with the call.
    const userMeta: Json =
      metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    const systemPrompt = extractSystemPrompt(message, rawMessages);
    const meta: Json = {
      ...(systemPrompt ? { customizable_prompt: systemPrompt } : {}),
      ...userMeta,
    };

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
      metadata: Object.keys(meta).length ? meta : null,
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
      console.info(`Tuner: sent call ${callId}${logEnriched ? " (log-enriched)" : ""}`);
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

/**
 * The system prompt this call's assistant ran with. With per-call provisioned
 * agents every call's prompt is different, so it's the default call metadata.
 */
function extractSystemPrompt(message: Json, rawMessages: Json[]): string | null {
  const sys = rawMessages.find(
    (m) => m?.role === "system" && typeof m.message === "string" && m.message,
  );
  if (sys) return sys.message;
  // Fallback: the assistant config embedded in the report.
  const modelMessages =
    message.assistant?.model?.messages ?? message.call?.assistant?.model?.messages;
  if (Array.isArray(modelMessages)) {
    const s = modelMessages.find(
      (m: Json) => m?.role === "system" && typeof m.content === "string" && m.content,
    );
    if (s) return s.content;
  }
  return null;
}

// =============================================================================
// VAPI CALL LOG — internal fetch + log-based enrichment
// =============================================================================
/**
 * Download and parse a VAPI call log (`message.artifact.logUrl`).
 *
 * The log is a gzipped JSONL file on VAPI's storage; no API key is needed.
 * Returns the parsed log lines, or null on any failure (missing URL, timeout,
 * bad response) — the caller then falls back to payload-only enrichment.
 */
async function fetchVapiLog(logUrl: unknown): Promise<Json[] | null> {
  if (typeof logUrl !== "string" || !logUrl) return null;
  try {
    const res = await fetch(logUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());

    let text: string;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      // gzip magic bytes -> decompress with Node's built-in zlib.
      // (Imported dynamically by name so the file stays type-checkable
      // without @types/node; runtime is Node 18+, where this always exists.)
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
  } catch {
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

/** Extract the per-turn pipeline events we use from raw log lines. */
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
 * Speech fragments from the log: final transcripts with speaker + turn labels.
 *
 * A final can arrive seconds late (interrupted speech finalizes lazily — even
 * after the next turn started speaking), so each final also carries the time
 * of the first PARTIAL transcript of its chain: partials stream while the
 * words are actually being spoken, making spokenTime the reliable "when was
 * this said" signal.
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

/** Lowercase letters and digits only — cosmetic differences can never break matching. */
function normText(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Text-anchored alignment: bind every transcript row to its log fragments.
 *
 * VAPI builds each transcript row by stitching together the log's transcriber
 * fragments. So per speaker channel we re-spell the rows from the fragments
 * (normalized text); each row learns exactly which fragments compose it — and
 * through them its turn tags and fragment timestamps.
 *
 * Validated on 14 real calls: the fragments are always a PREFIX of the rows —
 * the only uncovered text is the final goodbye, spoken as endCall kills the
 * pipeline before its transcript is finalized. Any other divergence (VAPI
 * rewording text, missing fragments) returns null -> caller falls back.
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
 * Enrich segments from VAPI's call log (ground truth) instead of deduction.
 *
 * Rows are bound to turns by TEXT (see alignRowsToTurns) — every row knows
 * exactly which turnIds it spans, so the data attaches by ID, not by counting
 * rows. That gives us what the end-of-call payload can't:
 *  - exact mapping of each turnLatencies entry to its rows (the entries are
 *    ordered by completed turn; the log lists those turns; rows carry them),
 *  - real metrics for post-tool replies (the second LLM run inside a tool
 *    turn is in the log but never published in turnLatencies),
 *  - exact interruptions (VAPI marks each barge-in it acted on with a
 *    `pipeline.cleared` event flagged `wasInterruption: true` — the same
 *    signal its own numAssistantInterrupted counter counts; this catches
 *    cuts that leave no timing overlap in the final transcript).
 *
 * Returns true when enrichment was applied; false means "fall back to the
 * payload-only logic" (e.g. log unreadable, or row text no longer matches
 * the fragments).
 */
function enrichFromLog(segments: Json[], log: VapiLog, turnLatencies: Json[]): boolean {
  const events = normalizeLogEvents(log);
  const frags = extractFragments(log);
  if (!events.length || !frags.length) return false;

  // Group events by turn; "completed" turns produced agent output (speech or
  // a tool invocation) — these are the turns turnLatencies entries describe.
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

  // Producing turn for AGENT speech, by SPOKEN time. Fragment turn-tags lag:
  // a transcript that finalizes after the next turn already started gets the
  // next turn's tag — and interrupted rows are exactly the ones that lag. The
  // fragment's spokenTime (first partial) and botSpeechStarted come from the
  // same log clock, so a fragment belongs to the completed turn whose speech
  // most recently started before it was heard.
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

  // Tail zip: the final goodbye is spoken as endCall kills the pipeline, so its
  // transcript never finalizes — pair leftover turns with uncovered agent rows.
  const assigned = new Set<number>();
  for (const s of segments) {
    if (s.role !== "agent") continue;
    for (const t of turnsOf.get(s) ?? []) assigned.add(t);
  }
  const leftoverTurns = completedTurnIds.filter((t) => !assigned.has(t));
  const uncoveredAgents = segments.filter(
    (s) => s.role === "agent" && covered.get(s) === false && (turnsOf.get(s)?.size ?? 0) === 0,
  );
  for (let i = 0; i < Math.min(leftoverTurns.length, uncoveredAgents.length); i++) {
    turnsOf.get(uncoveredAgents[i])?.add(leftoverTurns[i]);
  }

  // Index: turn -> its agent rows (in transcript order), user rows with the
  // FIRST turn they span (a multi-turn user row is the trigger of each of its
  // turns, so it is eligible from its first turn onward), and each row's
  // spoken time (first fragment's partial-chain start).
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

  // When a turn first produced output (speech or tool) — a turn's trigger must
  // have been spoken BEFORE this, which keeps backchannels spoken during the
  // response from stealing the trigger role.
  const turnFirstOut = new Map<number, number>();
  for (const tid of completedTurnIds) {
    for (const e of byTurn.get(tid)!) {
      if (e.event === "pipeline.botSpeechStarted" || e.event === "assistant.tool.started") {
        turnFirstOut.set(tid, Math.min(turnFirstOut.get(tid) ?? Infinity, e.time));
      }
    }
  }

  // Attach data per completed turn; entry #i belongs to completed turn #i.
  for (let i = 0; i < completedTurnIds.length; i++) {
    const T = completedTurnIds[i];
    const tl: Json | undefined = turnLatencies[i];
    const evs = byTurn.get(T)!;
    const speechRows = rowsOfTurn.get(T) ?? [];

    // STT -> the customer row that triggered this turn: the last user row whose
    // speech began at or before T AND was spoken before the turn's response
    // started (first turn wins on collisions).
    if (tl?.transcriberLatency != null) {
      const firstOut = turnFirstOut.get(T) ?? Infinity;
      const trigger =
        [...userRows].reverse().find((u) => u.minTurn <= T && u.spoken < firstOut)?.row ??
        [...userRows].reverse().find((u) => u.minTurn <= T)?.row;
      if (trigger && trigger.metadata?.stt_node_ttfb === undefined) {
        trigger.metadata = { ...(trigger.metadata ?? {}), stt_node_ttfb: tl.transcriberLatency };
      }
    }

    // First speech row: VAPI's published entry for the turn. A row spanning two
    // turns keeps the first turn's numbers (first-wins).
    if (speechRows[0] && tl && speechRows[0].metadata?.e2e_latency === undefined) {
      const md: Json = {};
      if (tl.turnLatency != null) md.e2e_latency = tl.turnLatency;
      if (tl.modelLatency != null) md.llm_node_ttft = tl.modelLatency;
      if (tl.voiceLatency != null) md.tts_node_ttfb = tl.voiceLatency;
      if (Object.keys(md).length) speechRows[0].metadata = { ...(speechRows[0].metadata ?? {}), ...md };
    }

    // Later speech rows of the turn (post-tool replies): metrics from the log's
    // extra runs, mapped ordinally within the turn.
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

  // Interruptions: VAPI marks each barge-in it acted on with a pipeline.cleared
  // event flagged wasInterruption: true. The event's own turnId can be an
  // ephemeral turn with no speech, so instead we match by TIME: build the bot's
  // speech intervals (botSpeechStarted -> botSpeechStopped) and flag the row
  // whose speech the cleared event landed inside. Cancellations before any
  // audio played (pre-speech barge-ins) land in no interval — there is no row
  // to flag for those, by definition.
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
    const hit = intervals.find((iv) => iv.start <= e.time && e.time <= iv.end + 100);
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

  // Merge bare continuation slices back into the utterance they belong to.
  // VAPI's stitcher splits one continuous utterance into several rows when the
  // customer backchannels mid-speech. The extra slice carries no measurement
  // (one speech run = one measurement, already on the first slice), so it
  // would render as an empty-looking row. Merging happens ONLY when provably
  // safe: the slice has no latency data of its own AND its producing turn is
  // the same as the preceding agent row's (rows of different turns, post-tool
  // replies, and anything with its own metrics are never touched).
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
    if (typeof r.end_ms === "number") {
      p.end_ms = typeof p.end_ms === "number" ? Math.max(p.end_ms, r.end_ms) : r.end_ms;
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

// =============================================================================
// TURN GROUPING + LATENCY ATTACHMENT (payload-only path)
// =============================================================================
type Turn = { trigger: Json | null; rows: Json[]; hasSpeech: boolean };

/**
 * Group transcript rows into response turns.
 *
 * Verified against VAPI's internal call logs (every log event carries a turnId):
 *  - A turn = one run of agent activity triggered by customer speech.
 *  - A tool call that follows agent speech in the same run starts a NEW turn
 *    (it is a fresh model decision). A tool call with no agent speech before
 *    it belongs to the current turn — its filler speech ("Give me a moment"),
 *    the tool result, and the post-result reply all stay in that same turn.
 *  - Agent speech before any customer speech (the greeting) has a null trigger.
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
 * Attach VAPI's turnLatencies to the right rows (payload-only path).
 *
 * VAPI emits ONE turnLatencies entry per completed agent response turn; the
 * canned firstMessage greeting gets none, and on tool-call turns VAPI reports
 * modelLatency/voiceLatency as 0.
 *
 * Per entry: stt -> the customer row that triggered the turn (first turn wins
 * when one customer row triggered two turns); llm/tts/e2e -> the turn's first
 * agent speech row. Continuation rows stay badge-less. Zeros are kept.
 */
function enrichWithTurnLatencies(segments: Json[], turnLatencies: Json[]): void {
  // Agent speech before any customer speech (the greeting) never gets an entry.
  const eligible = groupIntoTurns(segments).filter((t) => t.trigger !== null);

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
 * Flag agent turns the customer talked over (payload-only path).
 *
 * A barge-in is the customer starting to speak before the agent finished. We
 * compare each customer turn against the agent turn right before it; if it
 * starts before that agent turn ended (beyond a small threshold), the agent was
 * interrupted. The flag is stamped on the AGENT segment that got cut off.
 *
 * Note: this only catches barge-ins whose audio tail overlapped the customer in
 * the final timings. The call-log path (enrichFromLog) catches all of them.
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
