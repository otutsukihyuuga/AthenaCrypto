import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

const widgetHtml = readFileSync("public/widget.html", "utf8");

// ── CoinCap API v2 – completely free, no API key required ──────────────────
const COINCAP_BASE = "https://api.coincap.io/v2";

async function fetchAssets({ limit = 25, search = null } = {}) {
  let url = `${COINCAP_BASE}/assets?limit=${limit}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "athena-crypto-mcp/1.0",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CoinCap error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data ?? [];
}

function normalizeAsset(a) {
  const price = parseFloat(a.priceUsd) || null;
  const marketCap = parseFloat(a.marketCapUsd) || null;
  const volume = parseFloat(a.volumeUsd24Hr) || null;
  const change24h = parseFloat(a.changePercent24Hr) || null;
  const vwap24h = parseFloat(a.vwap24Hr) || null;

  return {
    id: a.id,
    rank: parseInt(a.rank, 10) || null,
    name: a.name,
    symbol: (a.symbol ?? "").toUpperCase(),
    price,
    marketCap,
    volume,
    change24h,
    vwap24h,
    // CoinCap icon CDN
    image: `https://assets.coincap.io/assets/icons/${(a.symbol ?? "").toLowerCase()}@2x.png`,
  };
}

function buildResponse(coins, { search = null, limit }) {
  const top = coins[0];
  const priceStr = top ? `$${parseFloat(top.price ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "N/A";
  const summary = search
    ? `Found ${coins.length} result(s) for "${search}". ${top ? `${top.name} is at ${priceStr} USD.` : ""}`
    : `Showing top ${coins.length} cryptocurrencies by market cap. ${top ? `${top.name} leads at ${priceStr} USD.` : ""}`;

  return {
    content: [{ type: "text", text: summary }],
    structuredContent: {
      coins,
      lastUpdated: new Date().toISOString(),
      ...(search ? { search } : {}),
    },
  };
}

// ── MCP server factory ─────────────────────────────────────────────────────

function createCryptoServer() {
  const server = new McpServer({ name: "crypto-markets", version: "1.0.0" });

  // ── Resource: widget HTML ──────────────────────────────────────────────
  server.registerResource(
    "crypto-widget",
    "ui://widget/crypto-markets.html",
    { description: "Interactive crypto market dashboard" },
    async () => ({
      contents: [
        {
          uri: "ui://widget/crypto-markets.html",
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: {
            "openai/widgetPrefersBorder": true,
            "openai/widgetDescription":
              "Live cryptocurrency market dashboard – shows top coins ranked by market cap with live prices, 24H volume, and % change. Supports sorting by any column, searching by name/symbol, and loading 10/25/50 coins.",
          },
        },
      ],
    })
  );

  // ── Tool 1: get_crypto_markets ─────────────────────────────────────────
  server.registerTool(
    "get_crypto_markets",
    {
      title: "Get Cryptocurrency Markets",
      description:
        "Use this when the user asks about crypto prices, market data, top coins, Bitcoin, Ethereum, altcoins, or wants to see a crypto market overview. Returns live data from CoinCap and renders an interactive widget.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(10)
          .max(50)
          .default(25)
          .describe("Number of top coins to show by market cap rank (10, 25, or 50)"),
      },
      _meta: {
        "openai/outputTemplate": "ui://widget/crypto-markets.html",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Fetching live crypto markets…",
        "openai/toolInvocation/invoked": "Markets loaded",
      },
    },
    async ({ limit = 25 }) => {
      try {
        const raw = await fetchAssets({ limit });
        const coins = raw.map(normalizeAsset);
        return buildResponse(coins, { limit });
      } catch (err) {
        console.error("get_crypto_markets error:", err);
        return {
          content: [{ type: "text", text: `Could not fetch market data: ${err.message}` }],
          structuredContent: { coins: [], lastUpdated: new Date().toISOString() },
        };
      }
    }
  );

  // ── Tool 2: search_crypto ──────────────────────────────────────────────
  server.registerTool(
    "search_crypto",
    {
      title: "Search Cryptocurrency",
      description:
        "Use this when the user wants to find a specific cryptocurrency by name or ticker symbol (e.g. 'find Solana', 'search DOGE', 'show me Chainlink price'). Returns live market data for matching coins.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Coin name or symbol to search for (e.g. 'solana', 'DOGE', 'chainlink')"),
      },
      _meta: {
        "openai/outputTemplate": "ui://widget/crypto-markets.html",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Searching…",
        "openai/toolInvocation/invoked": "Search complete",
      },
    },
    async ({ query }) => {
      try {
        const raw = await fetchAssets({ limit: 10, search: query });
        const coins = raw.map(normalizeAsset);
        return buildResponse(coins, { search: query, limit: coins.length });
      } catch (err) {
        console.error("search_crypto error:", err);
        return {
          content: [{ type: "text", text: `Search error: ${err.message}` }],
          structuredContent: { coins: [], lastUpdated: new Date().toISOString() },
        };
      }
    }
  );

  return server;
}

// ── HTTP server ────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3000);
const MCP_PATH = "/mcp";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const httpServer = createServer(async (req, res) => {
  if (!req.url) { res.writeHead(400).end("Missing URL"); return; }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS }).end(
      JSON.stringify({ status: "ok", name: "crypto-markets-mcp", version: "1.0.0", source: "CoinCap API" })
    );
    return;
  }

  if (url.pathname.startsWith(MCP_PATH) && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    const server = createCryptoServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404, CORS_HEADERS).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`\n🪙  Crypto Markets MCP server`);
  console.log(`   Data:      CoinCap API (free, no key)`);
  console.log(`   Listening: http://localhost:${port}${MCP_PATH}`);
  console.log(`   Health:    http://localhost:${port}/\n`);
});
