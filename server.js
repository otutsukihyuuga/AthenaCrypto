import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

const widgetHtml = readFileSync("public/widget.html", "utf8");

// ── CryptoCompare API – free, no key required for basic usage ──────────────
const CC_BASE = "https://min-api.cryptocompare.com/data";
const CC_IMG  = "https://www.cryptocompare.com";

async function fetchTopCoins(limit = 25) {
  // Fetch extra to account for coins that may lack USD data
  const fetchLimit = Math.min(limit * 3, 150);
  const url = `${CC_BASE}/top/mktcapfull?limit=${fetchLimit}&tsym=USD`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "athena-crypto-mcp/1.0" },
  });
  if (!res.ok) throw new Error(`CryptoCompare error ${res.status}`);
  const json = await res.json();
  if (json.Response === "Error") throw new Error(json.Message ?? "CryptoCompare error");

  // Filter to coins that have valid USD price data
  const valid = (json.Data ?? []).filter(
    (d) => d?.RAW?.USD?.PRICE > 0 && d?.CoinInfo?.Name
  );

  return valid.slice(0, limit).map((d, i) => normalizeCC(d, i + 1));
}

async function fetchCoinsBySymbols(symbols) {
  const fsyms = symbols.slice(0, 15).join(",");
  const url = `${CC_BASE}/pricemultifull?fsyms=${encodeURIComponent(fsyms)}&tsyms=USD`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "athena-crypto-mcp/1.0" },
  });
  if (!res.ok) throw new Error(`CryptoCompare pricemultifull error ${res.status}`);
  const json = await res.json();

  // Also need coin info for images — reuse top endpoint filtered
  const infoUrl = `${CC_BASE}/top/mktcapfull?limit=100&tsym=USD`;
  const infoRes = await fetch(infoUrl, { headers: { Accept: "application/json" } });
  const infoJson = await infoRes.json();
  const infoMap = {};
  (infoJson.Data ?? []).forEach((d) => {
    if (d?.CoinInfo?.Name) infoMap[d.CoinInfo.Name.toUpperCase()] = d.CoinInfo;
  });

  const coins = [];
  for (const sym of symbols) {
    const raw = json.RAW?.[sym]?.USD;
    if (!raw || !raw.PRICE) continue;
    const info = infoMap[sym.toUpperCase()] ?? {};
    coins.push({
      id: sym.toLowerCase(),
      rank: raw.MKTCAPRANK ?? null,
      name: info.FullName ?? raw.FROMSYMBOL ?? sym,
      symbol: sym.toUpperCase(),
      price: raw.PRICE ?? null,
      marketCap: raw.MKTCAP ?? null,
      volume: raw.TOTALVOLUME24H ?? null,
      change1h: raw.CHANGEPCTHOUR ?? null,
      change24h: raw.CHANGEPCT24HOUR ?? null,
      image: info.ImageUrl ? `${CC_IMG}${info.ImageUrl}` : null,
    });
  }
  return coins;
}

function normalizeCC(d, fallbackRank) {
  const info = d.CoinInfo ?? {};
  const raw  = d.RAW?.USD ?? {};
  return {
    id: (info.Name ?? "").toLowerCase(),
    rank: raw.MKTCAPRANK ?? fallbackRank,
    name: info.FullName ?? info.Name ?? "Unknown",
    symbol: (info.Name ?? "").toUpperCase(),
    price: raw.PRICE ?? null,
    marketCap: raw.MKTCAP ?? null,
    volume: raw.TOTALVOLUME24H ?? null,
    change1h: raw.CHANGEPCTHOUR ?? null,
    change24h: raw.CHANGEPCT24HOUR ?? null,
    image: info.ImageUrl ? `${CC_IMG}${info.ImageUrl}` : null,
  };
}

// Simple coin-name→symbol lookup for search (CryptoCompare search by name)
async function searchSymbols(query) {
  const url = `${CC_BASE}/top/mktcapfull?limit=100&tsym=USD`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json();
  const q = query.toLowerCase();
  const matches = (json.Data ?? []).filter((d) => {
    const name   = (d.CoinInfo?.FullName ?? "").toLowerCase();
    const symbol = (d.CoinInfo?.Name ?? "").toLowerCase();
    return name.includes(q) || symbol.includes(q);
  });
  return matches.slice(0, 10).map((d, i) => normalizeCC(d, i + 1));
}

function buildResponse(coins, { search = null }) {
  const top = coins[0];
  const priceStr = top?.price
    ? `$${top.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : "N/A";
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
    _meta: {
      "openai/outputTemplate": "ui://widget/crypto-markets.html",
    },
  };
}

// ── MCP server factory ─────────────────────────────────────────────────────

function createCryptoServer() {
  const server = new McpServer({ name: "crypto-markets", version: "1.0.0" });

  server.registerResource(
    "crypto-widget",
    "ui://widget/crypto-markets.html",
    { description: "Interactive crypto market dashboard" },
    async () => ({
      contents: [{
        uri: "ui://widget/crypto-markets.html",
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: {
          "openai/widgetPrefersBorder": true,
          "openai/widgetDescription":
            "Live crypto market dashboard. Shows top coins by market cap with price, volume, 1H/24H % change. Supports timeframe toggle, Top 10/25/50 limit, search, and column sort.",
          "openai/widgetDomain": "https://athenachat.bot",
          "openai/widgetCSP": {
            connect_domains: [
              "https://min-api.cryptocompare.com",
              "https://www.cryptocompare.com",
            ],
            resource_domains: [
              "https://www.cryptocompare.com",
            ],
          },
        },
      }],
    })
  );

  // Tool 1: get_crypto_markets
  server.registerTool(
    "get_crypto_markets",
    {
      title: "Get Cryptocurrency Markets",
      description:
        "Use this when the user asks about crypto prices, top coins, Bitcoin, Ethereum, altcoins, or wants a market overview. Returns live data from CryptoCompare with an interactive widget.",
      inputSchema: {
        limit: z
          .number().int().min(10).max(50).default(25)
          .describe("How many top coins to show by market cap (10, 25, or 50)"),
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
        const coins = await fetchTopCoins(limit);
        return buildResponse(coins, {});
      } catch (err) {
        console.error("get_crypto_markets error:", err);
        return {
          content: [{ type: "text", text: `Could not fetch market data: ${err.message}` }],
          structuredContent: { coins: [], lastUpdated: new Date().toISOString() },
        };
      }
    }
  );

  // Tool 2: search_crypto
  server.registerTool(
    "search_crypto",
    {
      title: "Search Cryptocurrency",
      description:
        "Use this when the user wants to find a specific cryptocurrency by name or ticker (e.g. 'find Solana', 'DOGE price', 'show me Chainlink'). Returns live price data for matching coins.",
      inputSchema: {
        query: z.string().min(1)
          .describe("Coin name or symbol to search for (e.g. 'solana', 'doge', 'chainlink')"),
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
        const coins = await searchSymbols(query);
        return buildResponse(coins, { search: query });
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const httpServer = createServer(async (req, res) => {
  if (!req.url) { res.writeHead(400).end("Missing URL"); return; }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") { res.writeHead(204, CORS).end(); return; }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json", ...CORS }).end(
      JSON.stringify({ status: "ok", name: "crypto-markets-mcp", version: "1.0.0", source: "CryptoCompare API" })
    );
    return;
  }

  if (url.pathname.startsWith(MCP_PATH) && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
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

  res.writeHead(404, CORS).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`\n🪙  Crypto Markets MCP server`);
  console.log(`   Data:      CryptoCompare API (free, no key)`);
  console.log(`   Listening: http://localhost:${port}${MCP_PATH}`);
  console.log(`   Health:    http://localhost:${port}/\n`);
});
