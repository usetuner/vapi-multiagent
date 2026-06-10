/**
 * VAPI Dynamic Agent Provisioning Server (transient) — Node.js / TypeScript
 * =========================================================================
 * Direct port of vapi_server.py, now with TOOLS.
 *
 * Flow:
 * 1. Inbound call -> VAPI sends an "assistant-request" webhook here.
 * 2. Fake CRM lookup -> random caller data.
 * 3. We return a transient assistant whose model has a set of TOOLS
 *    (lookupOrder, bookAppointment, checkBalance, transferToHuman).
 * 4. DURING the call, when the agent calls a tool, VAPI POSTs a "tool-calls"
 *    message to this same webhook. We execute it and reply with:
 *        { results: [{ toolCallId, result }] }
 * 5. On "end-of-call-report" we fetch VAPI's call log (optional enrichment),
 *    then forward the call to Tuner.
 *
 * No VAPI API key needed (transient agents live in the webhook response).
 *
 * Run:  npm install
 *       npm run dev          # listens on port 8000
 */

import express, { Request, Response } from "express";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fetchVapiLog, sendCallToTuner } from "./send_to_tuner_with_logs";

// Where each end-of-call report is stored as a JSON array.

const app = express();
app.use(express.json());

// Tiny timestamped logger to mirror the Python format.
function log(message: string): void {
  const t = new Date().toTimeString().slice(0, 8); // HH:MM:SS
  console.log(`${t} | INFO | ${message}`);
}

// =============================================================================
// Types
// =============================================================================
interface Customer {
  name: string;
  tier: "standard" | "premium";
  account_balance: string;
  loyalty_points: number;
}

// =============================================================================
// FAKE CRM — pretend this is a real network/database call
// =============================================================================
const FAKE_NAMES = ["Sarah Johnson", "Ahmed Hassan", "Maria Garcia", "John Smith", "Yuki Tanaka"];
const FAKE_TIERS: Array<"standard" | "premium"> = ["standard", "premium"];

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fakeCrmLookup(phoneNumber: string): Promise<Customer> {
  log(`CRM lookup for ${phoneNumber}...`);
  await sleep(randInt(300, 1200)); // simulate network latency

  const customer: Customer = {
    name: pick(FAKE_NAMES),
    tier: pick(FAKE_TIERS),
    account_balance: `$${randInt(0, 500)}.00`,
    loyalty_points: randInt(0, 5000),
  };
  log(`CRM returned: ${JSON.stringify(customer)}`);
  return customer;
}

// =============================================================================
// TOOLS — definitions sent to VAPI (what the agent is allowed to call)
// =============================================================================
const TOOLS = [
  {
    type: "function",
    function: {
      name: "lookupOrder",
      description: "Look up the status of a customer's order by its order number.",
      parameters: {
        type: "object",
        properties: {
          orderNumber: { type: "string", description: "The order number, e.g. 'A12345'." },
        },
        required: ["orderNumber"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bookAppointment",
      description: "Book an appointment for the caller. Use when they want to schedule something.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Desired date, e.g. 'June 20, 2026'." },
          time: { type: "string", description: "Desired time, e.g. '2:00 PM'." },
          reason: { type: "string", description: "Reason for the appointment." },
        },
        required: ["date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkBalance",
      description: "Get the caller's current account balance and loyalty points.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "transferToHuman",
      description: "Transfer the caller to a human agent when they ask or you cannot help.",
      parameters: {
        type: "object",
        properties: {
          department: {
            type: "string",
            enum: ["billing", "support", "sales"],
            description: "Which department to transfer to.",
          },
          reason: { type: "string", description: "Brief reason for the transfer." },
        },
        required: ["department"],
      },
    },
  },
  // Built-in VAPI tool: actually hangs up the call. VAPI executes this itself
  // (it does NOT hit our webhook), so there's no handler for it below.
  { type: "endCall" } as any,
];

// =============================================================================
// TOOL HANDLERS — what actually runs when the agent calls a tool mid-call.
// Each returns a STRING that the agent will read back to the caller.
// `customer` is the CRM record for this call (captured per call, see below).
// =============================================================================
type ToolArgs = Record<string, any>;

async function runTool(name: string, args: ToolArgs, customer: Customer | undefined): Promise<string> {
  switch (name) {
    case "lookupOrder": {
      await sleep(randInt(200, 600)); // pretend to hit an orders API
      const statuses = ["shipped", "out for delivery", "processing", "delivered"];
      const status = pick(statuses);
      const eta = `${randInt(1, 5)} day(s)`;
      return `Order ${args.orderNumber} is currently "${status}". Estimated delivery in ${eta}.`;
    }

    case "bookAppointment": {
      await sleep(randInt(200, 600)); // pretend to write to a calendar
      const reason = args.reason ? ` Reason: ${args.reason}.` : "";
      return `Appointment booked for ${args.date} at ${args.time}.${reason} A confirmation text will be sent shortly.`;
    }

    case "checkBalance": {
      if (!customer) return "I couldn't find your account details right now.";
      return `Your current balance is ${customer.account_balance} and you have ${customer.loyalty_points} loyalty points.`;
    }

    case "transferToHuman": {
      const dept = args.department ?? "support";
      return `Transferring you to the ${dept} team now. Please hold.`;
    }

    default:
      log(`Unknown tool: ${name}`);
      return "Sorry, I'm not able to do that right now.";
  }
}

// Remember the CRM record per call so tools like checkBalance can use it.
// (Transient agents are stateless on VAPI's side, so we keep a tiny map here.)
const callCustomers = new Map<string, Customer>();

// =============================================================================
// AGENT BUILDER
// =============================================================================
function buildAssistantConfig(customer: Customer): Record<string, unknown> {
  const systemPrompt = `You are a friendly, capable phone assistant for Acme Corp.

## Caller Info
- Name: ${customer.name}
- Tier: ${customer.tier}
- Account balance: ${customer.account_balance}
- Loyalty points: ${customer.loyalty_points}

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
- ${customer.tier === "premium" ? "This is a premium customer — be extra attentive and proactive." : "Standard customer."}
- Never invent account, order, or appointment details — rely on tool results.`;

  return {
    model: {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.7,
      messages: [{ role: "system", content: systemPrompt }],
      tools: TOOLS,
    },
    // No "voice" block on purpose — VAPI uses its default voice.
    firstMessage: `Hi ${customer.name}! Thanks for calling Acme Corp. How can I help?`,
  };
}

// =============================================================================
// WEBHOOK
// =============================================================================
app.post("/vapi/webhook", async (req: Request, res: Response) => {
  const message = req.body?.message ?? {};
  const msgType: string = message.type ?? "";
  log(`Received webhook: ${msgType}`);

  // ---- 1. Inbound call -> build a transient agent ----
  if (msgType === "assistant-request") {
    const callId: string = message.call?.id ?? "";
    const callerNumber: string = message.call?.customer?.number ?? "unknown";
    log(`Inbound call from: ${callerNumber}`);

    const customer = await fakeCrmLookup(callerNumber);
    if (callId) callCustomers.set(callId, customer); // remember for tool calls
    const assistantConfig = buildAssistantConfig(customer);

    return res.json({ assistant: assistantConfig });
  }

  // ---- 2. Mid-call tool calls -> execute and return results ----
  if (msgType === "tool-calls") {
    const callId: string = message.call?.id ?? "";
    const customer = callId ? callCustomers.get(callId) : undefined;

    // VAPI sends the list as toolCallList (or toolCalls on older payloads).
    const toolCalls: Json[] = message.toolCallList ?? message.toolCalls ?? [];

    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const id: string = tc.id;
        const fn: Json = tc.function ?? {};
        const name: string = fn.name;
        // arguments may arrive as an object or a JSON string.
        const args: ToolArgs =
          typeof fn.arguments === "string" ? safeJson(fn.arguments) : fn.arguments ?? {};

        log(`Tool call: ${name}(${JSON.stringify(args)})`);
        const result = await runTool(name, args, customer);
        return { toolCallId: id, result };
      }),
    );

    return res.json({ results });
  }

  // ---- 3. Call ended -> log reason + forward to Tuner ----
  if (msgType === "end-of-call-report") {
    const endedReason: string = message.endedReason ?? "(none)";
    log(`END-OF-CALL endedReason: ${endedReason}`);
    const RETURN_FILE = "vapi_return.json";

 
    const callId: string = message.call?.id ?? "";
    if (callId) callCustomers.delete(callId); // clean up our per-call memory

    const logUrl = message.artifact?.logUrl;
    log(`Fetching VAPI call log${logUrl ? "" : " (no logUrl in payload)"}...`);
    const vapiLog = await fetchVapiLog(logUrl);
    if (vapiLog) {
      log(`VAPI call log ready (${vapiLog.length} lines) — sending log-enriched payload to Tuner`);
    } else {
      log("VAPI call log unavailable — sending payload-only to Tuner");
    }
      appendReturn(message, vapiLog ?? []);
    await sendCallToTuner(message);
  }

  // Everything else: just acknowledge.
  return res.json({});
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "vapi-dynamic-agent-server" });
});

const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, "0.0.0.0", () => {
  log(`Server running on http://0.0.0.0:${PORT}`);
});

// =============================================================================
// Helpers
// =============================================================================
type Json = Record<string, any>;

function safeJson(s: string): Json {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function appendReturn(message: Json,logsData: Json[]): void {
  const RETURN_FILE = "vapi_return.json";
  const LOGS_FILE="vapi_log_return.json";

  const reports: Json[] = [];
  if (existsSync(RETURN_FILE)) {
    const raw = readFileSync(RETURN_FILE, "utf-8").trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) reports.push(...parsed);
      else reports.push(parsed);
    }
  }
  reports.push(message);
  writeFileSync(RETURN_FILE, JSON.stringify(reports, null, 2) + "\n");
  writeFileSync(LOGS_FILE, JSON.stringify(logsData ?? [], null, 2) + "\n");
}
