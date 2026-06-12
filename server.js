import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// ── OAuth helpers ──────────────────────────────────────────────────────────

// In-memory stores — reset on cold start, acceptable for a public data server
const pendingCodes = new Map(); // code -> { redirectUri, codeChallenge, state, expiresAt }
const activeTokens = new Set(); // bearer token strings

const generateToken = (bytes = 32) => randomBytes(bytes).toString("hex");

function verifyPKCE(verifier, challenge) {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

const readBody  = (req) => new Promise((resolve) => {
  let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => resolve(data));
});

const baseUrl = (req) =>
  `https://${req.headers.host ?? "athenacrypto.onrender.com"}`;

const widgetHtml = readFileSync("public/widget.html", "utf8");

// ── CryptoCompare API ──────────────────────────────────────────────────────
const CC_BASE   = "https://min-api.cryptocompare.com/data";
const CC_IMG    = "https://www.cryptocompare.com";
const CC_HEADERS = {
  Accept: "application/json",
  "User-Agent": "athena-crypto-mcp/1.0",
  ...(process.env.CC_API_KEY ? { authorization: `Apikey ${process.env.CC_API_KEY}` } : {}),
};

async function fetchTopCoins(limit = 25) {
  // Fetch extra to account for coins that may lack USD data
  // (CryptoCompare caps the limit param at 100 — anything above errors out)
  const fetchLimit = Math.min(limit * 3, 100);
  const url = `${CC_BASE}/top/mktcapfull?limit=${fetchLimit}&tsym=USD`;
  const res = await fetch(url, {
    headers: CC_HEADERS,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.Response === "Error" || json.Err?.message)
    throw new Error(json.Message ?? json.Err?.message ?? `CryptoCompare error ${res.status}`);

  // Filter to coins that have valid USD price data
  const valid = (Array.isArray(json.Data) ? json.Data : []).filter(
    (d) => d?.RAW?.USD?.PRICE > 0 && d?.CoinInfo?.Name
  );

  return valid.slice(0, limit).map((d, i) => normalizeCC(d, i + 1));
}

async function fetchCoinsBySymbols(symbols) {
  const fsyms = symbols.slice(0, 15).join(",");
  const url = `${CC_BASE}/pricemultifull?fsyms=${encodeURIComponent(fsyms)}&tsyms=USD`;
  const res = await fetch(url, {
    headers: CC_HEADERS,
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
  const res = await fetch(url, { headers: CC_HEADERS });
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
  const structured = {
    coins,
    lastUpdated: new Date().toISOString(),
    ...(search ? { search } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
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
              "https://athenacrypto.onrender.com",
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
          content: [{ type: "text", text: JSON.stringify({ error: err.message, coins: [], lastUpdated: new Date().toISOString() }) }],
          structuredContent: { error: err.message, coins: [], lastUpdated: new Date().toISOString() },
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
          content: [{ type: "text", text: JSON.stringify({ error: err.message, coins: [], lastUpdated: new Date().toISOString() }) }],
          structuredContent: { error: err.message, coins: [], lastUpdated: new Date().toISOString() },
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
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization",
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

  // ── Widget data proxy — keeps the CryptoCompare API key server-side ───────
  if (req.method === "GET" && url.pathname === "/api/markets") {
    const limit = Math.max(10, Math.min(50, Number(url.searchParams.get("limit")) || 25));
    try {
      const coins = await fetchTopCoins(limit);
      res.writeHead(200, { "content-type": "application/json", ...CORS })
         .end(JSON.stringify({ coins, lastUpdated: new Date().toISOString() }));
    } catch (err) {
      console.error("/api/markets error:", err);
      res.writeHead(502, { "content-type": "application/json", ...CORS })
         .end(JSON.stringify({ error: err.message, coins: [] }));
    }
    return;
  }

  // ── OAuth: discovery metadata (RFC 8414) ──────────────────────────────────
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    const base = baseUrl(req);
    res.writeHead(200, { "content-type": "application/json", ...CORS }).end(JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }));
    return;
  }

  // ── OAuth: dynamic client registration (RFC 7591) ─────────────────────────
  // Accepts any client — issues a client_id without storing secrets (public server)
  if (req.method === "POST" && url.pathname === "/oauth/register") {
    let clientMeta = {};
    try { clientMeta = JSON.parse(await readBody(req)); } catch (_) {}
    res.writeHead(201, { "content-type": "application/json", ...CORS }).end(JSON.stringify({
      client_id: generateToken(16),
      redirect_uris: clientMeta.redirect_uris ?? [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }));
    return;
  }

  // ── OAuth: authorization — pass-through, auto-approves immediately ─────────
  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    const { response_type, redirect_uri, code_challenge, state } =
      Object.fromEntries(url.searchParams);

    if (response_type !== "code" || !redirect_uri || !code_challenge) {
      res.writeHead(400).end("Invalid OAuth request");
      return;
    }

    const code = generateToken(16);
    pendingCodes.set(code, {
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      state,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute window
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    // Brief holding page that immediately forwards the code to the client
    res.writeHead(200, { "content-type": "text/html" }).end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${redirectUrl}">
  <title>Connecting — Athena Crypto</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; flex-direction: column;
           align-items: center; justify-content: center; height: 100vh; margin: 0;
           background: #0f172a; color: #e2e8f0; gap: 12px; }
    a { color: #38bdf8; }
  </style>
</head>
<body>
  <p>Connecting to <strong>Athena Crypto MCP</strong>…</p>
  <p><a href="${redirectUrl}">Click here if not redirected automatically</a></p>
</body>
</html>`);
    return;
  }

  // ── OAuth: token exchange with PKCE verification ───────────────────────────
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    const params      = new URLSearchParams(await readBody(req));
    const grantType   = params.get("grant_type");
    const code        = params.get("code");
    const redirectUri = params.get("redirect_uri");
    const verifier    = params.get("code_verifier");

    const fail = (err) =>
      res.writeHead(400, { "content-type": "application/json", ...CORS })
         .end(JSON.stringify({ error: err }));

    if (grantType !== "authorization_code" || !code || !verifier) return fail("invalid_request");

    const pending = pendingCodes.get(code);
    if (!pending || pending.expiresAt < Date.now()) return fail("invalid_grant");
    if (pending.redirectUri !== redirectUri)         return fail("invalid_grant");
    if (!verifyPKCE(verifier, pending.codeChallenge)) return fail("invalid_grant");

    pendingCodes.delete(code);
    const accessToken = generateToken(32);
    activeTokens.add(accessToken);

    res.writeHead(200, { "content-type": "application/json", ...CORS }).end(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 2592000, // 30 days
    }));
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
  console.log(`   Health:    http://localhost:${port}/`);
  console.log(`   OAuth:     http://localhost:${port}/.well-known/oauth-authorization-server\n`);
});
