# VAPI Multi-Agent Demo

A demo server that provisions **transient VAPI voice agents** per inbound call. Each caller gets a personalized assistant built from a fake CRM lookup, with mid-call tool execution (order lookup, appointments, balance check, transfer). When a call ends, the server optionally enriches the payload with VAPI's call log and forwards it to [Tuner](https://usetuner.ai).

The **recommended entry point** is the TypeScript server (`vapi_server.ts`). Python variants are included for comparison.

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- **npm**
- A [VAPI](https://vapi.ai) account with a phone number or SIP trunk
- A [Tuner](https://usetuner.ai) workspace (for end-of-call forwarding)
- A public HTTPS URL for local development (e.g. [ngrok](https://ngrok.com))

## Quick start (TypeScript)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Tuner

Edit the config block at the top of `send_to_tuner_with_logs.ts`:

| Variable | Where to find it |
|----------|------------------|
| `TUNER_BASE_URL` | Your Tuner API base URL (default: `https://api.usetuner.ai`) |
| `TUNER_API_KEY` | Tuner → Workspace Settings → API Keys (`tr_api_…`) |
| `TUNER_WORKSPACE` | Tuner → Workspace → General Settings (numeric ID) |
| `TUNER_AGENT_ID` | Create a **Custom API** agent in Tuner, then Agent Settings → Agent Connection |

### 3. Start the server

```bash
npm run dev
```

The server listens on **port 8000** by default. Override with:

```bash
PORT=3000 npm run dev
```

Verify it's running:

```bash
curl http://localhost:8000/health
```

### 4. Expose your local server to the internet

VAPI webhooks must reach your machine. Example with ngrok:

```bash
ngrok http 8000
```

Copy the HTTPS forwarding URL (e.g. `https://abc123.ngrok-free.app`).

### 5. Point VAPI at your webhook

In the [VAPI dashboard](https://dashboard.vapi.ai):

1. Open your **Phone Number** (or Assistant / Squad, depending on your setup).
2. Set the **Server URL** to:

   ```
   https://<your-public-url>/vapi/webhook
   ```

3. Save. Place a test call to that number.

## What happens on a call

1. **Inbound call** → VAPI sends an `assistant-request` webhook.
2. **Fake CRM lookup** → random caller name, tier, balance, and loyalty points.
3. **Transient assistant** → returned inline in the webhook response (no VAPI API key required).
4. **Mid-call tools** → when the agent invokes a tool, VAPI POSTs `tool-calls`; the server runs the handler and returns results.
5. **Call ends** → on `end-of-call-report`, the server fetches the VAPI call log (if available), appends the report to local JSON files, and forwards the call to Tuner.

### Available tools

| Tool | Purpose |
|------|---------|
| `lookupOrder` | Fake order status lookup |
| `bookAppointment` | Fake appointment booking |
| `checkBalance` | Returns CRM balance and loyalty points |
| `transferToHuman` | Simulated transfer to billing / support / sales |
| `endCall` | Built-in VAPI tool to hang up |

## Local output files

After calls complete, the server writes:

- `vapi_return.json` — array of `end-of-call-report` payloads
- `vapi_log_return.json` — latest VAPI call log (JSONL parsed to an array)

These are gitignored and meant for local debugging.

## Alternative servers (Python)

### Transient agent (simpler, no tools)

```bash
pip install fastapi uvicorn
python vapi_server.py
```

Listens on port **8000**. Same webhook path: `/vapi/webhook`.

### Persistent agent (creates a dashboard assistant per call)

```bash
export VAPI_API_KEY="your-vapi-private-key"
pip install fastapi uvicorn httpx
python vapi_server_persistent.py
```

Listens on port **8001**. Requires a VAPI private API key. **Note:** creates a new assistant in your VAPI dashboard on every call.

## Project structure

| File | Description |
|------|-------------|
| `vapi_server.ts` | Main TypeScript server (tools + Tuner forwarding) |
| `send_to_tuner_with_logs.ts` | Tuner integration and call-log enrichment |
| `send_to_tuner.ts` | Tuner integration without log enrichment |
| `send_to_tuner.py` | Python version of the Tuner client |
| `vapi_server.py` | Minimal Python transient-agent server |
| `vapi_server_persistent.py` | Python server that creates persistent VAPI assistants |

## Troubleshooting

- **Webhook not firing** — confirm the public URL is HTTPS and ends with `/vapi/webhook`.
- **Calls not appearing in Tuner** — check the four config values in `send_to_tuner_with_logs.ts` and watch server logs for `Tuner:` warnings.
- **Empty transcript in Tuner** — the `end-of-call-report` must include `artifact.messages`; this depends on your VAPI assistant settings.
- **Port already in use** — set `PORT` to another value or stop the process on 8000.
