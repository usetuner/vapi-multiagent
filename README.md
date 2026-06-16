# VAPI transient agents — Node & Python

A worked example of **transient VAPI voice agents**: instead of pre-creating an
assistant in the VAPI dashboard, you hand VAPI a brand-new assistant *inline*,
per call, in your webhook response. Every caller gets a personalized agent built
on the fly from a CRM lookup, with real mid-call tool execution, and every
finished call is forwarded to [Tuner](https://usetuner.ai) for analysis.

The same server is implemented twice — pick your language:

| | |
|---|---|
| 🟢 **[`nodeAgent/`](./nodeAgent)** | Express + TypeScript |
| 🐍 **[`pythonAgent/`](./pythonAgent)** | FastAPI + Python |

Both expose the identical webhook (`POST /vapi/webhook`), the identical tools,
and the identical end-of-call → Tuner pipeline. Each folder has its own README
with setup and run steps.

## What "transient" means

A **persistent** agent is created once (via the VAPI API) and lives in your
dashboard; calls reference it by id. A **transient** agent has no id and no
prior existence — you return its full config in the `assistant-request`
webhook, VAPI spins it up for that one call, and it's gone when the call ends.

Why that's useful:

- **Personalization per call** — bake the caller's name, tier, and account data
  straight into the system prompt and first message.
- **No dashboard sprawl** — you don't create (and later clean up) one assistant
  per caller.
- **No VAPI API key needed** — the agent lives entirely in your webhook
  response.

## The flow

```
   ┌─────────┐   1. assistant-request    ┌──────────────────┐
   │  Caller │ ───────────────────────▶  │   Your webhook   │
   └─────────┘                           │  /vapi/webhook   │
        ▲                                └──────────────────┘
        │                                   │  2. fake CRM lookup
        │  transient assistant (inline)     │  3. return assistant
        │ ◀─────────────────────────────────┘     { model, tools, firstMessage }
        │
        │  …conversation…
        │
        │  4. tool-calls  ──────────────▶  run tool, return { results: [...] }
        │ ◀─────────────────────────────
        │
        │  5. end-of-call-report ───────▶  fetch VAPI call log, persist locally,
        │                                  forward enriched call to Tuner
```

1. **Inbound call** → VAPI sends an `assistant-request` webhook.
2. **CRM lookup** → a fake lookup returns a random caller name, tier, balance,
   and loyalty points (swap in a real HTTP/DB call for production).
3. **Transient assistant** → returned inline in the webhook response, with a set
   of tools the agent may call.
4. **Mid-call tools** → when the agent invokes a tool, VAPI POSTs a `tool-calls`
   message to the same webhook; the server runs the handler and returns results
   the agent reads back to the caller.
5. **Call ends** → on `end-of-call-report`, the server downloads VAPI's call log
   (one extra GET, no API key), appends the report to local JSON files, and
   forwards the call to Tuner with exact per-turn latencies and interruptions.

### Available tools

| Tool | Purpose |
|------|---------|
| `lookupOrder` | Fake order-status lookup |
| `bookAppointment` | Fake appointment booking |
| `checkBalance` | Returns the CRM balance and loyalty points |
| `transferToHuman` | Simulated transfer to billing / support / sales |
| `endCall` | Built-in VAPI tool to hang up (executed by VAPI itself) |

## Sending calls to Tuner

Both agents ship a self-contained Tuner client — `send_to_tuner.ts` /
`send_to_tuner.py` — that you can drop next to any VAPI server. Call
`sendCallToTuner(message)` / `send_call_to_tuner(message)` from your
`end-of-call-report` handler and the finished call (transcript, tool calls, tool
results, latencies, interruptions) shows up under your Tuner agent. It's
fire-and-forget and never throws. See the config block at the top of either file
for the four dashboard values it needs.

## Local output files

After calls complete, each server writes (in its own folder, both gitignored):

- `vapi_return.json` — array of `end-of-call-report` payloads (with `callLog`)
- `vapi_log_return.json` — per-call VAPI logs (JSONL parsed to an array)

## Also in this repo

- `vapi_server_persistent.py` — a contrasting **persistent**-agent server that
  creates a real assistant in your VAPI dashboard per call (requires a VAPI
  private API key). Kept for comparison with the transient approach above.
