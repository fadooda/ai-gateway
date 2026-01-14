// src/server.js
import express from "express";
import { makeCatalogTool } from "./catalogTool.js";
import { shouldUseCatalog, normalizeQuery, applyPriceGuardrails } from "./nlp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL ?? "http://localhost:3001";

const { tools, handlers } = makeCatalogTool({ catalogUrl: CATALOG_SERVICE_URL });

async function ollamaChat({ messages, tools }) {
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      tools,
      think: false,
      stream: false,
      options: { temperature: 0.2 },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  return await resp.json();
}

app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Body must include messages: [{role, content}, ...]" });
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const mustUseTool = shouldUseCatalog(lastUser);

    const system = {
      role: "system",
      content:
        "You are a helpful assistant that can also act as a game store assistant or a friend. " +
        "If the user asks about games/prices/recommendations, you MUST call search_games first and answer only from tool results. " +
        "Otherwise, chat like a normal smart ai."
    };

    const convo = [system, ...messages];

    const first = await ollamaChat({ messages: convo, tools });
    const msg = first?.message;
    convo.push(msg);

    let toolCalls = msg?.tool_calls ?? [];

    // deterministic fallback if needed
    if (mustUseTool && toolCalls.length === 0) {
      toolCalls = [{ function: { name: "search_games", arguments: { query: lastUser, limit: 5 } } }];
    }

    for (const tc of toolCalls) {
      const name = tc?.function?.name;

      let args = tc?.function?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }

      if (!args.limit) args.limit = 5;

      // keep LLM query if present, fallback to user; then sanitize
      args = normalizeQuery(lastUser, args);

      // enforce price intent from user message
      args = applyPriceGuardrails(lastUser, args);

      const handler = handlers[name];
      const result = handler ? await handler(args) : { error: `No handler registered for tool: ${name}` };

      convo.push({
        role: "tool",
        tool_name: name,
        name,
        tool_call_id: tc?.id,
        content: JSON.stringify(result),
      });
    }

    convo.push({
      role: "system",
      content: "Tool results have been provided. Now answer. Do NOT call any tools.",
    });

    const final = await ollamaChat({ messages: convo, tools: [] });

    return res.json({ answer: final?.message?.content ?? "", model: final?.model });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ai-gateway listening on http://localhost:${PORT}`);
  console.log(`Using Ollama: ${OLLAMA_HOST} model=${OLLAMA_MODEL}`);
  console.log(`Catalog service: ${CATALOG_SERVICE_URL}`);
});
