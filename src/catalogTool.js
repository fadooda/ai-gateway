// src/catalogTool.js

function toNumberPrice(p) {
  if (p == null) return null;
  if (typeof p === "number") return p;
  if (typeof p === "string") {
    const n = Number(p.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function buildToolsSchema() {
  return [
    {
      type: "function",
      function: {
        name: "search_games",
        description: "Search games with optional price filters (under/above/range/exact/closest).",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Keywords, or empty for any." },
            limit: { type: "integer", default: 5 },
            min_price: { type: "number" },
            max_price: { type: "number" },
            exact_price: { type: "number" },
            target_price: { type: "number" },
            min_inclusive: { type: "boolean", default: true },
            max_inclusive: { type: "boolean", default: true },
            price_mode: {
              type: "string",
              enum: ["none", "under", "above", "range", "exact", "closest"],
              default: "none"
            }
          }
        }
      }
    }
  ];
}

export function makeCatalogTool({ catalogUrl }) {
  async function fetchCatalogResults(query) {
    const resp = await fetch(`${catalogUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 50 }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`catalog-service error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    return Array.isArray(data?.results) ? data.results : [];
  }

  async function searchGames({
    query,
    limit = 5,
    min_price,
    max_price,
    exact_price,
    target_price,
    min_inclusive = true,
    max_inclusive = true,
    price_mode = "none",
  }) {
    const original_query = (query ?? "").trim();

    let raw = await fetchCatalogResults(original_query);

    let fallback_used = false;
    if (raw.length === 0 && original_query !== "") {
      raw = await fetchCatalogResults("");
      fallback_used = true;
    }

    const withPrice = raw
      .map((g) => ({ ...g, _price: toNumberPrice(g?.priceUSD) }))
      .filter((g) => g._price != null);

    const eps = 0.01;

    let filtered = withPrice.filter((g) => {
      const p = g._price;

      if (price_mode === "exact" && exact_price != null) return Math.abs(p - exact_price) < eps;

      if (min_price != null) {
        if (min_inclusive ? !(p >= min_price) : !(p > min_price)) return false;
      }

      if (max_price != null) {
        if (max_inclusive ? !(p <= max_price) : !(p < max_price)) return false;
      }

      return true;
    });

    if (price_mode === "closest" && target_price != null) {
      filtered.sort((a, b) => Math.abs(a._price - target_price) - Math.abs(b._price - target_price));
    } else if (price_mode === "under" && max_price != null) {
      filtered.sort((a, b) => (max_price - a._price) - (max_price - b._price));
    } else if (price_mode === "above" && min_price != null) {
      filtered.sort((a, b) => (a._price - min_price) - (b._price - min_price));
    } else {
      filtered.sort((a, b) => a._price - b._price);
    }

    return {
      query_original: original_query,
      query_used: fallback_used ? "" : original_query,
      fallback_used,
      price_mode,
      min_price,
      max_price,
      exact_price,
      target_price,
      results: filtered.slice(0, limit).map(({ _price, ...g }) => g),
    };
  }

  return {
    tools: buildToolsSchema(),
    handlers: { search_games: searchGames },
  };
}