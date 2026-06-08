# Athena Crypto MCP

A custom [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI assistants live access to cryptocurrency market data — prices, market caps, 24h/1h changes, and trading volume.

**Live:** https://athenacrypto.onrender.com/

Data is sourced from [CryptoCompare](https://www.cryptocompare.com/) — no API key required.

---

## Tools

| Tool | Description |
|------|-------------|
| `get_crypto_markets` | Top N coins by market cap (10 / 25 / 50) with price, volume, and % change |
| `search_crypto` | Find any coin by name or ticker and get live price data |

Both tools return an interactive HTML widget alongside the structured data.

---

## Connecting

### Claude.ai (free, beta)

1. Go to **claude.ai → Settings → Integrations**
2. Add a new connector with this URL:
   ```
   https://athenacrypto.onrender.com/mcp
   ```
3. Claude will self-register via OAuth and connect automatically — no login or approval needed.

> **Note:** The server runs on Render's free tier and sleeps after 15 min of inactivity. On a cold start, existing tokens are cleared and Claude will re-authorize itself on the next tool call.

### Cursor / Windsurf (free)

Open MCP settings and add:

```json
{
  "mcpServers": {
    "athena-crypto": {
      "url": "https://athenacrypto.onrender.com/mcp"
    }
  }
}
```

### Claude Code CLI (Pro / API)

```bash
claude mcp add athena-crypto --transport http https://athenacrypto.onrender.com/mcp
```

---

## OAuth Endpoints

The server implements OAuth 2.0 + PKCE (MCP remote server spec) so that clients like Claude.ai can connect without any manual credential setup.

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-authorization-server` | Discovery metadata |
| `POST /oauth/register` | Dynamic client registration (RFC 7591) |
| `GET /oauth/authorize` | Authorization — pass-through, auto-approves |
| `POST /oauth/token` | Token exchange with PKCE verification |

Tokens are stored in memory. No user accounts, no secrets — this is a public data server.

---

## Local Development

```bash
npm install
npm run dev        # node --watch, port 3000
```

| URL | Purpose |
|-----|---------|
| `http://localhost:3000/` | Health check |
| `http://localhost:3000/mcp` | MCP endpoint |
| `http://localhost:3000/.well-known/oauth-authorization-server` | OAuth discovery |

---

## Stack

| | |
|-|-|
| Runtime | Node.js (ESM) |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Data | CryptoCompare free API |
| Auth | OAuth 2.0 + PKCE (in-memory, no DB) |
| Hosting | [Render](https://render.com/) free tier |
| Validation | Zod |

---

## Project Structure

```
athena-crypto/
├── server.js         # MCP server, OAuth layer, HTTP handler
├── public/
│   └── widget.html   # Interactive crypto dashboard widget
└── package.json
```
