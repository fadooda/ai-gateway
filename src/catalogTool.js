// src/catalogTool.js

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
              default: "none",
            },
          },
        },
      },
    },
  ];
}

export function makeCatalogTool({ catalogUrl }) {
  async function fetchCatalogResults(query, limit = 50) {
    const resp = await fetch(`${catalogUrl}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`catalog-service error ${resp.status} for query="${query}": ${text}`);
    }

    const data = await resp.json();
    return Array.isArray(data?.results) ? data.results : [];
  }

  async function searchGames({ query, limit = 5 }) {
    const q = (query ?? "").trim();
    const raw = await fetchCatalogResults(q);

    return {
      query_original: q,
      query_used: q,
      fallback_used: false,
      results: raw.slice(0, limit),
    };
  }

  return {
    tools: buildToolsSchema(),
    handlers: { search_games: searchGames },
  };
}
