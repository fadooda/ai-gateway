// src/nlp.js

export function shouldUseCatalog(text = "") {
  return /\b(recommend|suggest|game|games|price|cost|under|below|less than|more than|over|between|around|almost|close to|\$)\b/i.test(
    text
  );
}

export function parsePriceIntent(text = "") {
  let m =
    text.match(/between\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:and|to)\s*\$?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\$?\s*(\d+(?:\.\d+)?)\s*-\s*\$?\s*(\d+(?:\.\d+)?)/);

  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { price_mode: "range", min_price: Math.min(a, b), max_price: Math.max(a, b) };
    }
  }

  m = text.match(/(?:costs?|priced\s+at|exactly|for)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) return { price_mode: "exact", exact_price: x };
  }

  m = text.match(/(?:more\s+than|over|>|>=|at\s+least)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) {
      const inclusive = /(?:>=|at\s+least)/i.test(m[0]);
      return { price_mode: "above", min_price: x, min_inclusive: inclusive };
    }
  }

  m = text.match(/(?:under|below|<|<=|less\s+than)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) {
      const inclusive = /<=/i.test(m[0]);
      return { price_mode: "under", max_price: x, max_inclusive: inclusive };
    }
  }

  m = text.match(/(?:almost|around|about|near|close\s+to)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) return { price_mode: "closest", target_price: x };
  }

  return { price_mode: "none" };
}

const STOPWORDS = new Set([
  "recommend", "suggest", "show", "give",
  "game", "games", "genre", "genres",
  "explain", "why",
  "one", "that", "this", "these", "those", "it",
  "a", "an", "the",
  "me", "i", "you", "we", "my",
  "please",
  "cost", "costs", "priced", "price", "pricing",
  "under", "below", "less", "than", "more", "over", "at", "least",
  "between", "and", "to",
  "around", "about", "almost", "near", "close",
  "from", "any", "all", "anything", "everything",
]);

export function deriveQuery(text = "") {
  let q = String(text).toLowerCase();

  q = q
    .replace(/[$<>]=?/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  q = q
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = q
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .filter((t) => !STOPWORDS.has(t));

  return tokens.length ? tokens.join(" ") : "";
}
