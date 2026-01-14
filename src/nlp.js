// src/nlp.js
//
// Deterministic NLP helpers for the AI gateway.
//
// Goals:
// - Decide when we MUST call the catalog tool (vs normal chat)
// - Parse price constraints from user text in a predictable way (no guessing)
// - Reduce user/LLM text into "keywords only" query strings
// - Apply guardrails so tool args match what the USER asked for (not hallucinated budgets)

/**
 * Heuristic router:
 * Returns true when the message likely requires catalog lookup (games + price/recommend intent).
 *
 * NOTE: This is intentionally simple and fast. If you want fewer false positives,
 * tighten the regex or add separate checks for "game" + "recommend" + "price".
 */
export function shouldUseCatalog(text = "") {
  return /\b(recommend|suggest|game|games|price|cost|under|below|less than|more than|over|between|around|almost|close to|\$)\b/i.test(
    text
  );
}

/**
 * Deterministic price intent parser.
 *
 * Supported patterns (USD-ish):
 *  - range:   "between $8 and $15" OR "$8-$15"
 *  - exact:   "costs $10" / "priced at $10" / "exactly $10" / "for $10"
 *  - above:   "more than $10" / "over $10" / ">= $10" / "at least $10"
 *  - under:   "under $10" / "below $10" / "< $10" / "<= $10"
 *  - closest: "around $10" / "about $10" / "near $10" / "close to $10" / "almost $10"
 *
 * Returns a small object containing price_mode + relevant numeric fields.
 * If nothing is detected, returns { price_mode: "none" }.
 */
export function parsePriceIntent(text = "") {
  // 1) RANGE: "between 8 and 15" or "8-15"
  let m =
    text.match(/between\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:and|to)\s*\$?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\$?\s*(\d+(?:\.\d+)?)\s*-\s*\$?\s*(\d+(?:\.\d+)?)/);

  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return {
        price_mode: "range",
        min_price: Math.min(a, b),
        max_price: Math.max(a, b),
      };
    }
  }

  // 2) EXACT: "costs 10", "priced at 10", "exactly 10", "for 10"
  m = text.match(/(?:costs?|priced\s+at|exactly|for)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) return { price_mode: "exact", exact_price: x };
  }

  // 3) ABOVE: "more than 10", "over 10", "> 10", ">= 10", "at least 10"
  m = text.match(/(?:more\s+than|over|>|>=|at\s+least)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) {
      // inclusive only matters for >= / at least
      const inclusive = /(?:>=|at\s+least)/i.test(m[0]);
      return { price_mode: "above", min_price: x, min_inclusive: inclusive };
    }
  }

  // 4) UNDER: "under 10", "below 10", "< 10", "<= 10", "less than 10"
  m = text.match(/(?:under|below|<|<=|less\s+than)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) {
      const inclusive = /<=/i.test(m[0]);
      return { price_mode: "under", max_price: x, max_inclusive: inclusive };
    }
  }

  // 5) CLOSEST: "around 10", "about 10", "near 10", "close to 10", "almost 10"
  m = text.match(/(?:almost|around|about|near|close\s+to)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const x = Number(m[1]);
    if (Number.isFinite(x)) return { price_mode: "closest", target_price: x };
  }

  return { price_mode: "none" };
}

/**
 * Stopwords for deriveQuery().
 * These are "filler" tokens that often appear in requests but don't help searching.
 *
 * NOTE: Keep "co-op" searchable (hyphens are preserved in deriveQuery).
 * NOTE: Tweak this list as you add more domains (e.g., "pc", "steam", etc.).
 */
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

/**
 * Extract keywords for catalog search.
 *
 * - Lowercase
 * - Remove numeric tokens (prices)
 * - Remove operators/symbols commonly used for price constraints ($, <, >, <=, >=)
 * - Remove punctuation (but preserve hyphens so "co-op" stays intact)
 * - Remove stopwords
 *
 * Returns:
 * - "keyword keyword" string if meaningful tokens exist
 * - "" if no meaningful tokens remain (caller may treat as wildcard search)
 */
export function deriveQuery(text = "") {
  let q = String(text).toLowerCase();

  // Remove common budget symbols and standalone numbers.
  // This prevents queries like "under $15" from polluting keyword search.
  q = q
    .replace(/[$<>]=?/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Keep letters, digits, spaces, and hyphens (hyphens keep "co-op").
  q = q.replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();

  const tokens = q
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 1)        // drop 1-letter junk tokens
    .filter((t) => !STOPWORDS.has(t));  // drop filler tokens

  return tokens.length ? tokens.join(" ") : "";
}

/**
 * Server-side guardrails for pricing.
 *
 * Why this exists:
 * - The LLM may invent budgets or slightly shift boundaries.
 * - We want the tool call constraints to match the user message deterministically.
 *
 * Rules:
 * 1) If the USER did NOT specify any price intent:
 *    - force price_mode="none" and delete all price fields (ignore any LLM-invented constraints)
 *
 * 2) If the USER DID specify price intent:
 *    - enforce parsed fields onto args, even if the LLM provided different ones.
 *
 * Return value:
 * - A new args object (spread merge) for the enforcement case
 * - The same args object (mutated) when clearing price filters
 *
 * NOTE: If you want fully immutable behavior, return new objects in all branches.
 */
export function applyPriceGuardrails(lastUser, args = {}) {
  const parsed = parsePriceIntent(lastUser);

  // Detect if the model tried to provide any price filters.
  // We currently DON'T trust it if user intent disagrees.
  const llmProvidedPrice = Boolean(
    (args.price_mode && args.price_mode !== "none") ||
    args.min_price != null ||
    args.max_price != null ||
    args.exact_price != null ||
    args.target_price != null
  );

  // If user didn't specify price, strip *any* LLM-provided price filtering.
  if (parsed.price_mode === "none") {
    args.price_mode = "none";
    delete args.min_price;
    delete args.max_price;
    delete args.exact_price;
    delete args.target_price;
    delete args.min_inclusive;
    delete args.max_inclusive;
    return args;
  }

  // User DID specify price; enforce parsed constraints (even if LLM did).
  // You could optionally log when LLMProvidedPrice=true and differs from parsed.
  return { ...args, ...parsed };
}

/**
 * Normalize tool args into a safe, catalog-friendly query string.
 *
 * Behavior:
 * - If LLM provided args.query, use it (allows the LLM to narrow search, e.g. "co-op dungeon")
 * - Otherwise fallback to the raw user message
 * - Always sanitize into keywords via deriveQuery()
 *
 * Note:
 * - This function does NOT apply price parsing. Use applyPriceGuardrails() separately.
 */
export function normalizeQuery(lastUser, args = {}) {
  const baseQuery =
    typeof args.query === "string" && args.query.trim()
      ? args.query
      : lastUser;

  return { ...args, query: deriveQuery(baseQuery) };
}
