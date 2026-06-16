"""
VAPI Dynamic Agent Provisioning Server (transient) — Python / FastAPI
=====================================================================
Direct port of vapi_server.ts, now with TOOLS.

Flow:
1. Inbound call -> VAPI sends an "assistant-request" webhook here.
2. Fake CRM lookup -> random caller data.
3. We return a transient assistant whose model has a set of TOOLS
   (lookupOrder, bookAppointment, checkBalance, transferToHuman).
4. DURING the call, when the agent calls a tool, VAPI POSTs a "tool-calls"
   message to this same webhook. We execute it and reply with:
       {"results": [{"toolCallId": ..., "result": ...}]}
5. On "end-of-call-report" we fetch VAPI's call log (optional enrichment),
   then forward the call to Tuner.

No VAPI API key needed (transient agents live in the webhook response).

Run:  pip install fastapi uvicorn requests --break-system-packages
      python vapi_server.py        # listens on port 8000
"""

import asyncio
import json
import logging
import os
import random
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

from send_to_tuner import fetch_vapi_log, send_call_to_tuner

# Tiny timestamped logger to mirror the TS "HH:MM:SS | INFO | message" format.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vapi-server")


def log(message: str) -> None:
    logger.info(message)


app = FastAPI(title="VAPI Dynamic Agent Server")

# Where each end-of-call report is stored as a JSON array.
RETURN_FILE = "vapi_return.json"
LOGS_FILE = "vapi_log_return.json"

Json = dict[str, Any]


# =============================================================================
# FAKE CRM — pretend this is a real network/database call
# =============================================================================
FAKE_NAMES = ["Sarah Johnson", "Ahmed Hassan", "Maria Garcia", "John Smith", "Yuki Tanaka"]
FAKE_TIERS = ["standard", "premium"]


async def fake_crm_lookup(phone_number: str) -> Json:
    """
    Pretend to call a CRM. Adds a realistic delay and returns random fake data.
    Swap this out for a real HTTP/DB call later.
    """
    log(f"CRM lookup for {phone_number}...")
    await asyncio.sleep(random.randint(300, 1200) / 1000)  # simulate network latency

    customer: Json = {
        "name": random.choice(FAKE_NAMES),
        "tier": random.choice(FAKE_TIERS),
        "account_balance": f"${random.randint(0, 500)}.00",
        "loyalty_points": random.randint(0, 5000),
    }
    log(f"CRM returned: {json.dumps(customer)}")
    return customer


# =============================================================================
# TOOLS — definitions sent to VAPI (what the agent is allowed to call)
# =============================================================================
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookupOrder",
            "description": "Look up the status of a customer's order by its order number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "orderNumber": {"type": "string", "description": "The order number, e.g. 'A12345'."},
                },
                "required": ["orderNumber"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bookAppointment",
            "description": "Book an appointment for the caller. Use when they want to schedule something.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {"type": "string", "description": "Desired date, e.g. 'June 20, 2026'."},
                    "time": {"type": "string", "description": "Desired time, e.g. '2:00 PM'."},
                    "reason": {"type": "string", "description": "Reason for the appointment."},
                },
                "required": ["date", "time"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "checkBalance",
            "description": "Get the caller's current account balance and loyalty points.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "transferToHuman",
            "description": "Transfer the caller to a human agent when they ask or you cannot help.",
            "parameters": {
                "type": "object",
                "properties": {
                    "department": {
                        "type": "string",
                        "enum": ["billing", "support", "sales"],
                        "description": "Which department to transfer to.",
                    },
                    "reason": {"type": "string", "description": "Brief reason for the transfer."},
                },
                "required": ["department"],
            },
        },
    },
    # Built-in VAPI tool: actually hangs up the call. VAPI executes this itself
    # (it does NOT hit our webhook), so there's no handler for it below.
    {"type": "endCall"},
]


# =============================================================================
# TOOL HANDLERS — what actually runs when the agent calls a tool mid-call.
# Each returns a STRING that the agent will read back to the caller.
# `customer` is the CRM record for this call (captured per call, see below).
# =============================================================================
async def run_tool(name: str, args: Json, customer: Optional[Json]) -> str:
    if name == "lookupOrder":
        await asyncio.sleep(random.randint(200, 600) / 1000)  # pretend to hit an orders API
        status = random.choice(["shipped", "out for delivery", "processing", "delivered"])
        eta = f"{random.randint(1, 5)} day(s)"
        return f'Order {args.get("orderNumber")} is currently "{status}". Estimated delivery in {eta}.'

    if name == "bookAppointment":
        await asyncio.sleep(random.randint(200, 600) / 1000)  # pretend to write to a calendar
        reason = f" Reason: {args['reason']}." if args.get("reason") else ""
        return (
            f'Appointment booked for {args.get("date")} at {args.get("time")}.{reason} '
            "A confirmation text will be sent shortly."
        )

    if name == "checkBalance":
        if not customer:
            return "I couldn't find your account details right now."
        return (
            f"Your current balance is {customer['account_balance']} and you have "
            f"{customer['loyalty_points']} loyalty points."
        )

    if name == "transferToHuman":
        dept = args.get("department") or "support"
        return f"Transferring you to the {dept} team now. Please hold."

    log(f"Unknown tool: {name}")
    return "Sorry, I'm not able to do that right now."


# Remember the CRM record per call so tools like checkBalance can use it.
# (Transient agents are stateless on VAPI's side, so we keep a tiny map here.)
call_customers: dict[str, Json] = {}


# =============================================================================
# AGENT BUILDER
# =============================================================================
def build_assistant_config(customer: Json) -> Json:
    premium_line = (
        "This is a premium customer — be extra attentive and proactive."
        if customer["tier"] == "premium"
        else "Standard customer."
    )
    system_prompt = f"""You are a friendly, capable phone assistant for Acme Corp.

## Caller Info
- Name: {customer['name']}
- Tier: {customer['tier']}
- Account balance: {customer['account_balance']}
- Loyalty points: {customer['loyalty_points']}

## What you can do (use your tools — never make up results)
- Check order status with lookupOrder (ask for the order number).
- Book appointments with bookAppointment (collect date and time first).
- Tell the caller their balance/points with checkBalance.
- Transfer to a human with transferToHuman when asked or when stuck.
- When the caller is done, FIRST say a short, warm goodbye out loud (e.g. "Thanks for calling Acme Corp, Maria — have a great day!"), THEN call endCall. Never call endCall before speaking your farewell.

## Rules
- Greet the caller by name.
- Be concise and conversational — this is a phone call, not an essay.
- Always confirm details (dates, order numbers) before calling a tool.
- {premium_line}
- Never invent account, order, or appointment details — rely on tool results."""

    return {
        "model": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.7,
            "messages": [{"role": "system", "content": system_prompt}],
            "tools": TOOLS,
        },
        # No "voice" block on purpose — VAPI uses its default voice.
        "firstMessage": f"Hi {customer['name']}! Thanks for calling Acme Corp. How can I help?",
    }


# =============================================================================
# WEBHOOK
# =============================================================================
@app.post("/vapi/webhook")
async def vapi_webhook(request: Request):
    body = await request.json()
    message: Json = body.get("message") or {}
    msg_type: str = message.get("type") or ""
    log(f"Received webhook: {msg_type}")

    # ---- 1. Inbound call -> build a transient agent ----
    if msg_type == "assistant-request":
        call = message.get("call") or {}
        call_id: str = call.get("id") or ""
        caller_number: str = (call.get("customer") or {}).get("number") or "unknown"
        log(f"Inbound call from: {caller_number}")

        customer = await fake_crm_lookup(caller_number)
        if call_id:
            call_customers[call_id] = customer  # remember for tool calls
        assistant_config = build_assistant_config(customer)

        return JSONResponse(content={"assistant": assistant_config})

    # ---- 2. Mid-call tool calls -> execute and return results ----
    if msg_type == "tool-calls":
        call = message.get("call") or {}
        call_id = call.get("id") or ""
        customer = call_customers.get(call_id) if call_id else None

        # VAPI sends the list as toolCallList (or toolCalls on older payloads).
        tool_calls: list[Json] = message.get("toolCallList") or message.get("toolCalls") or []

        async def handle(tc: Json) -> Json:
            tc_id = tc.get("id")
            fn: Json = tc.get("function") or {}
            name = fn.get("name")
            # arguments may arrive as an object or a JSON string.
            raw_args = fn.get("arguments")
            args: Json = safe_json(raw_args) if isinstance(raw_args, str) else (raw_args or {})

            log(f"Tool call: {name}({json.dumps(args)})")
            result = await run_tool(name, args, customer)
            return {"toolCallId": tc_id, "result": result}

        results = await asyncio.gather(*(handle(tc) for tc in tool_calls))
        return JSONResponse(content={"results": list(results)})

    # ---- 3. Call ended -> log reason + forward to Tuner ----
    if msg_type == "end-of-call-report":
        ended_reason: str = message.get("endedReason") or "(none)"
        log(f"END-OF-CALL endedReason: {ended_reason}")

        # VAPI also fires stub SIP reports (artifact: {}) with no transcript/logUrl.
        # Skip those — they would wipe vapi_log_return.json and pollute vapi_return.json.
        if not is_complete_end_of_call_report(message):
            log(f"Skipping incomplete end-of-call-report ({ended_reason}) — no artifact data")
            return JSONResponse(content={})

        call = message.get("call") or {}
        call_id = call.get("id") or ""
        if call_id:
            call_customers.pop(call_id, None)  # clean up our per-call memory

        artifact: Json = message.get("artifact") or {}
        log_url = artifact.get("logUrl") or message.get("logUrl")
        log(f"Fetching VAPI call log{'' if log_url else ' (no logUrl in payload)'}...")
        vapi_log = await asyncio.to_thread(fetch_vapi_log, log_url)
        if vapi_log:
            log(f"VAPI call log ready ({len(vapi_log)} lines) — saving locally and sending to Tuner")
        else:
            log("VAPI call log unavailable — saving payload only, sending payload-only to Tuner")
        append_return(message, vapi_log)

        messages = artifact.get("messages") or []
        prompt = messages[0].get("message") if messages else None
        metadata = {"customizable_prompt": prompt} if prompt else None
        await asyncio.to_thread(send_call_to_tuner, message, metadata, vapi_log)
        return JSONResponse(content={})

    # Everything else: just acknowledge.
    return JSONResponse(content={})


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vapi-dynamic-agent-server"}


# =============================================================================
# Helpers
# =============================================================================
def safe_json(s: str) -> Json:
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, dict) else {}
    except ValueError:
        return {}


def is_complete_end_of_call_report(message: Json) -> bool:
    """Real end-of-call reports carry artifact data; SIP stubs send `artifact: {}`."""
    artifact: Json = message.get("artifact") or {}
    return bool(
        artifact.get("logUrl")
        or message.get("logUrl")
        or (artifact.get("messages") or [])
        or (message.get("messages") or [])
        or artifact.get("recordingUrl")
        or message.get("recordingUrl")
        or artifact.get("stereoRecordingUrl")
        or message.get("stereoRecordingUrl")
    )


def read_json_array(file: str) -> list[Json]:
    path = Path(file)
    if not path.exists():
        return []
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return []
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, list) else [parsed]


def append_return(message: Json, logs_data: Optional[list[Json]]) -> None:
    entry: Json = {**message}
    if logs_data:
        entry["callLog"] = logs_data

    reports = read_json_array(RETURN_FILE)
    reports.append(entry)
    Path(RETURN_FILE).write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")

    # Append per-call logs; never overwrite with [] when a fetch fails.
    if logs_data:
        call_id = (message.get("call") or {}).get("id")
        logs = read_json_array(LOGS_FILE)
        logs.append(
            {
                "call_id": call_id,
                "ended_reason": message.get("endedReason"),
                "log": logs_data,
            }
        )
        Path(LOGS_FILE).write_text(json.dumps(logs, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    log(f"Server running on http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
