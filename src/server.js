// src/server.js
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

/**
 * Minimal proxy to Ollama /api/chat.
 * - Accepts: { messages: [{ role, content }, ...] }
 * - Returns: { answer, model }
 */
async function ollamaChat({ messages }) {
  const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      // keep it simple and predictable for a proxy
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
      return res
        .status(400)
        .json({ error: "Body must include messages: [{role, content}, ...]" });
    }

    const out = await ollamaChat({ messages });

    return res.json({
      answer: out?.message?.content ?? "",
      model: out?.model ?? OLLAMA_MODEL,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ai-gateway listening on http://localhost:${PORT}`);
  console.log(`Using Ollama: ${OLLAMA_HOST} model=${OLLAMA_MODEL}`);
});
