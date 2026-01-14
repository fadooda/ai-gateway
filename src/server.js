/**
 * ai-gateway (server.js)
 *
 * Goals:
 * - Expose a single /chat endpoint that proxies chat messages to Ollama.
 * - When the user asks for game recommendations/prices, ensure the catalog tool is called.
 * - Execute tool calls server-side (trusted), then feed tool results back to the model.
 * - Apply guardrails so pricing intent comes from the user message (not model hallucination).
 *
 * Non-goals:
 * - Persist conversations / sessions (stateless HTTP).
 * - Implement the catalog search logic here (lives in catalogTool.js).
 * - Do advanced NLU / intent models (nlp.js is simple regex + keyword cleanup).
 */

import express from "express";
import { makeCatalogTool } from "./catalogTool.js";
import { shouldUseCatalog, normalizeQuery, applyPriceGuardrails } from "./nlp.js";

// -----------------------------------------------------------------------------
// App setup
// -----------------------------------------------------------------------------
const app = express();

// Accept JSON bodies (chat messages + tool metadata). 1mb is plenty for typical chat.
app.use(express.json({ limit: "1mb" }));

// -----------------------------------------------------------------------------
// Configuration (env-driven for local dev + deployment)
// -----------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000);

// Ollama runtime (local by default)
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

// Separate service that provides the game catalog search endpoint
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL ?? "http://localhost:3001";

// Build tool schema + handlers once at startup.
// - tools: JSON schema sent to the LLM so it can emit tool_calls
// - handlers: actual Node functions that execute tool logic
const { tools, handlers } = makeCatalogTool({ catalogUrl: CATALOG_SERVICE_URL });

// -----------------------------------------------------------------------------
// Ollama client wrapper
// -----------------------------------------------------------------------------
/**
 * Call Ollama /api/chat with an optional tools schema.
 *
 * IMPORTANT:
 * - If `tools` is provided, the model may return `message.tool_calls`
 * - We run tools in Node, then feed results back as role="tool" messages
 */
async function ollamaChat({ messages, tools }) {
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      tools, // when set, model can emit tool_calls
      think: false, // keep responses fast; tool_args are usually fine without "thinking"
      stream: false,
      options: { temperature: 0.2 }, // low-ish temp for stable tool args + answers
    }),
  });

  // Normalize errors into something readable for logs / callers.
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  return await resp.json();
}

// -----------------------------------------------------------------------------
// Main endpoint: /chat
// -----------------------------------------------------------------------------
/**
 * POST /chat
 * Body:
 *  {
 *    messages: [{ role: "user"|"assistant"|"system", content: string }, ...]
 *  }
 *
 * Flow:
 *  1) Send messages (+ system prompt + tools schema) to Ollama
 *  2) If model emits tool_calls (or we detect user needs tool), execute tool(s)
 *  3) Append tool results to the conversation (role="tool")
 *  4) Ask Ollama again to produce final answer (with tools disabled)
 */
app.post("/chat", async (req, res) => {
  try {
    // Validate input shape early
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ error: "Body must include messages: [{role, content}, ...]" });
    }

    // Extract the latest user message (used for heuristics + deterministic guardrails)
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

    // Heuristic: if the user is asking for game recommendations/prices, we expect a tool call.
    // This protects against the model occasionally not emitting tool_calls.
    const mustUseTool = shouldUseCatalog(lastUser);

    // Single system prompt to set behavior boundaries:
    // - tool usage is mandatory for game-related queries
    // - non-game queries can be answered normally
    const system = {
      role: "system",
      content:
        "You are a helpful assistant that can also act as a game store assistant or a friend. " +
        "If the user asks about games/prices/recommendations, you MUST call search_games first and answer only from tool results. " +
        "Otherwise, chat like a normal smart ai.",
    };

    // Conversation we send to Ollama (mutated as we append tool results)
    const convo = [system, ...messages];

    // ---- Step 1: Ask the model (it may respond with tool_calls)
    const first = await ollamaChat({ messages: convo, tools });
    const msg = first?.message;
    convo.push(msg);

    // Tool calls are emitted in message.tool_calls (Ollama format)
    let toolCalls = msg?.tool_calls ?? [];

    // ---- Deterministic fallback:
    // If user clearly needs the catalog tool but model didn't emit tool_calls,
    // we create a minimal tool call ourselves.
    if (mustUseTool && toolCalls.length === 0) {
      toolCalls = [
        {
          function: {
            name: "search_games",
            arguments: { query: lastUser, limit: 5 },
          },
        },
      ];
    }

    // ---- Step 2: Execute tool calls (server-side), then append results as role="tool"
    for (const tc of toolCalls) {
      const name = tc?.function?.name;

      // Tool arguments can be an object or a JSON string depending on model/backend.
      let args = tc?.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }

      // Enforce a safe default for result count (prevents accidental huge responses)
      if (!args.limit) args.limit = 5;

      // Normalize query:
      // - Keep LLM-proposed query if present (useful when it extracts "co-op", "racing", etc.)
      // - Otherwise fall back to lastUser
      // - Then sanitize to keywords-only (removes prices / filler words)
      args = normalizeQuery(lastUser, args);

      // Guardrails:
      // - Price intent is determined from the user message (source of truth)
      // - Prevents the model from inventing budgets or subtle mismatches
      args = applyPriceGuardrails(lastUser, args);

      // Dispatch to our registered handler for the tool name
      const handler = handlers[name];
      const result = handler
        ? await handler(args)
        : { error: `No handler registered for tool: ${name}` };

      // Provide tool output back to the model in the expected "tool" message format.
      // Notes:
      // - tool_call_id ties the tool response to the original request in some tool APIs.
      // - We include both `tool_name` and `name` for compatibility across model variants.
      convo.push({
        role: "tool",
        tool_name: name,
        name,
        tool_call_id: tc?.id,
        content: JSON.stringify(result),
      });
    }

    // ---- Step 3: Final response generation (tools disabled to prevent more tool calls)
    convo.push({
      role: "system",
      content: "Tool results have been provided. Now answer. Do NOT call any tools.",
    });

    const final = await ollamaChat({ messages: convo, tools: [] });

    // Return only the final assistant text + model name
    return res.json({
      answer: final?.message?.content ?? "",
      model: final?.model,
    });
  } catch (err) {
    // Keep error payload simple for clients
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// Basic health endpoint for Docker / k8s / uptime checks
app.get("/health", (_req, res) => res.json({ ok: true }));

// Start server
app.listen(PORT, () => {
  console.log(`ai-gateway listening on http://localhost:${PORT}`);
  console.log(`Using Ollama: ${OLLAMA_HOST} model=${OLLAMA_MODEL}`);
  console.log(`Catalog service: ${CATALOG_SERVICE_URL}`);
});
