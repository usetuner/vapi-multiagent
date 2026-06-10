"""
VAPI Dynamic Agent Provisioning Server (simplified)
===================================================
Flow:
1. An inbound call hits VAPI -> VAPI sends an "assistant-request" webhook here.
2. We "look up" the caller's number in a CRM. Here that's a FAKE async API
   call with a small delay that returns random fake data (name, tier, etc.).
3. We build a brand-new assistant config with that info baked into the prompt
   and return it to VAPI. VAPI spins up that ephemeral agent for the call.

Run:  pip install fastapi uvicorn --break-system-packages
      python vapi_server.py
"""

import asyncio
import logging
import random

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vapi-server")

app = FastAPI(title="VAPI Dynamic Agent Server")


# =============================================================================
# FAKE CRM — pretend this is a real network/database call
# =============================================================================
FAKE_NAMES = ["Sarah Johnson", "Ahmed Hassan", "Maria Garcia", "John Smith", "Yuki Tanaka"]
FAKE_TIERS = ["standard", "premium"]


async def fake_crm_lookup(phone_number: str) -> dict:
    """
    Pretend to call a CRM. Adds a realistic delay and returns random fake data.
    Swap this out for a real HTTP/DB call later.
    """
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
def build_assistant_config(customer: dict) -> dict:
    """Build a fresh VAPI assistant with the caller's info in the prompt."""

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

    return {
        "model": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.7,
            "messages": [{"role": "system", "content": system_prompt}],
        },
        # NOTE: no "voice" block on purpose — VAPI uses its default voice.
        # Add a voice back only with a VALID provider/voiceId combo, e.g.:
        #   "voice": {"provider": "vapi", "voiceId": "Elliot"}
        "firstMessage": f"Hi {customer['name']}! Thanks for calling Acme Corp. How can I help?",
    }


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
        assistant_config = build_assistant_config(customer)

        return JSONResponse(content={"assistant": assistant_config})

    # Log WHY a call ended — this tells us if VAPI rejected our assistant.
    if msg_type == "end-of-call-report":
        ended_reason = message.get("endedReason", "(none)")
        logger.info(f"END-OF-CALL endedReason: {ended_reason}")

    # Everything else: just acknowledge.
    return JSONResponse(content={})


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vapi-dynamic-agent-server"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
