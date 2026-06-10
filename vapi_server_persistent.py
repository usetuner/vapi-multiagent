"""
VAPI Persistent Agent Provisioning Server
=========================================
Difference from vapi_server.py:
  - vapi_server.py returns the assistant INLINE -> "transient" agent that does
    NOT appear in the dashboard.
  - THIS server CREATES a real assistant via the VAPI API (POST /assistant),
    then returns its assistantId -> the agent IS saved and viewable in the
    dashboard Assistants list.

Flow:
1. Inbound call -> VAPI sends "assistant-request" webhook here.
2. Fake CRM lookup -> random caller data.
3. POST that config to https://api.vapi.ai/assistant  (creates a real agent).
4. Return {"assistantId": "<new id>"} -> VAPI uses it for this call.

Requires your VAPI PRIVATE API key:
    export VAPI_API_KEY="your-private-key-here"

Run:  pip install fastapi uvicorn httpx --break-system-packages
      python vapi_server_persistent.py     # listens on port 8001

NOTE: this creates a NEW persistent assistant on EVERY call. They will pile up
in your dashboard quickly. See cleanup note at the bottom.
"""

import asyncio
import logging
import os
import random
from datetime import datetime

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vapi-server-persistent")

app = FastAPI(title="VAPI Persistent Agent Server")

VAPI_API_KEY = os.environ.get("VAPI_API_KEY", "")
VAPI_BASE_URL = "https://api.vapi.ai"


# =============================================================================
# FAKE CRM — pretend this is a real network/database call
# =============================================================================
FAKE_NAMES = ["Sarah Johnson", "Ahmed Hassan", "Maria Garcia", "John Smith", "Yuki Tanaka"]
FAKE_TIERS = ["standard", "premium"]


async def fake_crm_lookup(phone_number: str) -> dict:
    """Pretend to call a CRM. Adds a delay and returns random fake data."""
    logger.info(f"CRM lookup for {phone_number}...")
    await asyncio.sleep(random.uniform(0.3, 1.2))  # simulate network latency

    customer = {
        "name": random.choice(FAKE_NAMES),
        "tier": random.choice(FAKE_TIERS),
        "account_balance": f"${random.randint(0, 500)}.00",
        "loyalty_points": random.randint(0, 5000),
    }
    logger.info(f"CRM returned: {customer}")
    return customer


# =============================================================================
# AGENT BUILDER
# =============================================================================
def build_assistant_config(customer: dict, caller_number: str) -> dict:
    """Build the assistant payload. 'name' is what shows in the dashboard."""

    system_prompt = f"""You are a friendly phone assistant for Acme Corp.

## Caller Info
- Name: {customer['name']}
- Tier: {customer['tier']}
- Account balance: {customer['account_balance']}
- Loyalty points: {customer['loyalty_points']}

## Rules
- Greet the caller by name.
- Be concise and conversational — this is a phone call.
- {"This is a premium customer — be extra attentive." if customer['tier'] == 'premium' else "Standard customer."}
- Never make up account details beyond what's listed above.
"""

    # A descriptive name so each call's agent is easy to find in the dashboard.
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    name = f"{customer['name']} ({caller_number}) - {stamp}"

    return {
        "name": name,
        "model": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.7,
            "messages": [{"role": "system", "content": system_prompt}],
        },
        # No "voice" block -> VAPI default voice (add a valid one if you want).
        "firstMessage": f"Hi {customer['name']}! Thanks for calling Acme Corp. How can I help?",
    }


async def create_vapi_assistant(config: dict) -> str | None:
    """Create a real assistant via the VAPI API. Returns its id, or None on failure."""
    if not VAPI_API_KEY:
        logger.error("VAPI_API_KEY is not set — cannot create a persistent assistant.")
        return None

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{VAPI_BASE_URL}/assistant",
            headers={"Authorization": f"Bearer {VAPI_API_KEY}"},
            json=config,
        )

    if resp.status_code in (200, 201):
        assistant_id = resp.json().get("id")
        logger.info(f"Created persistent assistant: {assistant_id}")
        return assistant_id

    logger.error(f"Failed to create assistant: {resp.status_code} {resp.text}")
    return None


# =============================================================================
# WEBHOOK
# =============================================================================
@app.post("/vapi/webhook")
async def vapi_webhook(request: Request):
    body = await request.json()
    message = body.get("message", {})
    msg_type = message.get("type", "")
    logger.info(f"Received webhook: {msg_type}")

    if msg_type == "assistant-request":
        caller_number = message.get("call", {}).get("customer", {}).get("number", "unknown")
        logger.info(f"Inbound call from: {caller_number}")

        customer = await fake_crm_lookup(caller_number)
        config = build_assistant_config(customer, caller_number)

        # Create a REAL assistant in VAPI and use its id for this call.
        assistant_id = await create_vapi_assistant(config)

        if assistant_id:
            return JSONResponse(content={"assistantId": assistant_id})

        # Fallback: if creation failed, still serve the call with a transient agent
        # so the caller isn't dropped. (Won't appear in the dashboard.)
        logger.warning("Falling back to a transient (inline) assistant.")
        config.pop("name", None)  # 'name' isn't valid on a transient assistant
        return JSONResponse(content={"assistant": config})

    if msg_type == "end-of-call-report":
        ended_reason = message.get("endedReason", "(none)")
        logger.info(f"END-OF-CALL endedReason: {ended_reason}")

    return JSONResponse(content={})


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vapi-persistent-agent-server", "api_key_set": bool(VAPI_API_KEY)}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)


# =============================================================================
# CLEANUP TIP
# =============================================================================
# Every call creates a new assistant, so the list grows fast. To delete one:
#   curl -X DELETE https://api.vapi.ai/assistant/<id> \
#        -H "Authorization: Bearer $VAPI_API_KEY"
# For production you'd typically delete it in the end-of-call-report handler,
# or reuse/update a single assistant instead of creating one per call.
