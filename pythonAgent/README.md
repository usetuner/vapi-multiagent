# Python agent (FastAPI)

A transient VAPI voice-agent server in Python. On each inbound call it builds a
personalized assistant from a (fake) CRM lookup, executes the agent's tools
mid-call, and on hang-up forwards the call — with VAPI call-log enrichment — to
[Tuner](https://usetuner.ai).

This is the line-for-line counterpart of [`../nodeAgent`](../nodeAgent). Same
webhook, same tools, same flow — pick whichever language you prefer.

## Files

| File | Description |
|------|-------------|
| `vapi_server.py` | The webhook server (transient agent + tools + Tuner forwarding) |
| `send_to_tuner.py` | Tuner client + VAPI call-log enrichment (no third-party deps beyond `requests`) |
| `requirements.txt` | `fastapi`, `uvicorn`, `requests` |

## Prerequisites

- **Python 3.10+**
- A [VAPI](https://vapi.ai) account with a phone number or SIP trunk
- A [Tuner](https://usetuner.ai) workspace (for end-of-call forwarding)
- A public HTTPS URL for local dev (e.g. [ngrok](https://ngrok.com))

## 1. Install dependencies

```bash
cd pythonAgent
python -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
```

## 2. Configure Tuner

Edit the config block at the top of `send_to_tuner.py`:

| Variable | Where to find it |
|----------|------------------|
| `TUNER_BASE_URL` | Your Tuner API base URL (default: `https://api.usetuner.ai`) |
| `TUNER_API_KEY` | Tuner → Workspace Settings → API Keys (`tr_api_…`) |
| `TUNER_WORKSPACE` | Tuner → Workspace → General Settings (numeric ID) |
| `TUNER_AGENT_ID` | Create a **Custom API** agent in Tuner, then Agent Settings → Agent Connection |

> The server still runs without valid Tuner credentials — it just logs a
> `Tuner:` warning and never breaks call handling.

## 3. Start the server

```bash
python vapi_server.py            # listens on port 8000
PORT=3000 python vapi_server.py  # or override the port
```

Verify:

```bash
curl http://localhost:8000/health
```

## 4. Expose it and point VAPI at it

```bash
ngrok http 8000
```

In the [VAPI dashboard](https://dashboard.vapi.ai), set your Phone Number's
**Server URL** to:

```
https://<your-public-url>/vapi/webhook
```

Then place a test call.

## Available tools

| Tool | Purpose |
|------|---------|
| `lookupOrder` | Fake order-status lookup |
| `bookAppointment` | Fake appointment booking |
| `checkBalance` | Returns the CRM balance and loyalty points |
| `transferToHuman` | Simulated transfer to billing / support / sales |
| `endCall` | Built-in VAPI tool to hang up (executed by VAPI, not this server) |

## Local output files

After calls complete the server writes (in the working directory, both
gitignored):

- `vapi_return.json` — array of `end-of-call-report` payloads (with `callLog` attached)
- `vapi_log_return.json` — per-call VAPI logs (JSONL parsed to an array)

## Notes

- The Tuner client is synchronous; the server runs `fetch_vapi_log` and
  `send_call_to_tuner` in a thread (`asyncio.to_thread`) so the event loop stays
  responsive.
- Swap `fake_crm_lookup` for a real HTTP/DB call to make this production-shaped.
