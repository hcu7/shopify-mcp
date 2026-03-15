# cob-shopify-mcp

The definitive open-source MCP server for Shopify. Bridges AI agents, chatbots, and automation pipelines to the Shopify Admin GraphQL API through the Model Context Protocol -- and ships a full CLI for scripts, CI, and quick lookups.

## Highlights

| Feature | Detail |
|---------|--------|
| **64 tools** | 59 built-in TypeScript + 5 custom YAML tools across 5 domains |
| **Dual-mode** | MCP server for AI agents **and** `cob-shopify` CLI for humans |
| **ShopifyQL analytics** | 16 analytics tools powered by ShopifyQL -- single API call, no cursor pagination |
| **Advertise-and-Activate** | Optional lazy loading registers 1 meta-tool instead of 59 schemas (82% token reduction) |
| **Production-grade** | Cost-based rate limiting, response caching, retry with backoff, audit logging |
| **Config-driven** | Enable/disable tools, read-only mode, custom YAML tools, tier system |
| **Multiple auth methods** | Client credentials (recommended), static token, OAuth authorization code |
| **Two transports** | stdio (local) and Streamable HTTP (hosted/Docker) |

## Quick Install

```bash
npm install -g cob-shopify-mcp
```

Or run without installing:

```bash
npx cob-shopify-mcp start
```

## Documentation

| Page | Description |
|------|-------------|
| [Getting Started](Getting-Started) | Installation, credentials setup, first commands, MCP connection |
| [Tool Reference](Tool-Reference) | All 64 tools organized by domain with CLI examples |
| [Configuration & Auth](Configuration-and-Auth) | Auth methods, YAML config, env vars, tool management |
| [Roadmap & FAQ](Roadmap-and-FAQ) | Future plans and frequently asked questions |
| [Changelog](https://github.com/svinpeace/cob-shopify-mcp/blob/main/CHANGELOG.md) | Release history |

## Links

- **npm:** [cob-shopify-mcp](https://www.npmjs.com/package/cob-shopify-mcp)
- **GitHub:** [svinpeace/cob-shopify-mcp](https://github.com/svinpeace/cob-shopify-mcp)
- **License:** MIT
