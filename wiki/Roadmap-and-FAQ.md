# Roadmap and FAQ

## Roadmap

| Version | Theme | Key Features |
|---------|-------|--------------|
| **v0.7.0** | Smart Caching & Cost Optimization | Write-through cache invalidation, request batching, cost budget CLI dashboard |
| **v0.8.0** | Metafields & Discounts | Metafields CRUD, discount management, tier 2 tools |
| **v0.9.0** | Webhooks & Real-time | Webhook subscriptions, event receiver, automation recipes |
| **v1.0.0** | Production Hardening | Multi-store management, full API coverage, plugin system |
| **v2.0.0** | Hosted MCP-as-a-Service | Multi-tenant hosting, browser OAuth, admin dashboard, billing |

### v0.7.0 -- Smart Caching & Cost Optimization

Introduces write-through cache invalidation so mutations automatically refresh related cached reads. Request batching groups multiple small queries into single API calls to reduce cost point consumption. A CLI cost dashboard shows real-time API budget usage per store.

### v0.8.0 -- Metafields & Discounts

Adds full CRUD operations for metafields on products, orders, customers, and collections. Discount management tools cover price rules, automatic discounts, and discount codes. Ships the first batch of tier 2 tools (currently disabled by default) as production-ready.

### v0.9.0 -- Webhooks & Real-time

Enables webhook subscription management through MCP tools -- create, list, update, and delete webhooks. An event receiver processes incoming webhook payloads and makes them available as MCP resources. Automation recipes provide pre-built workflows like "notify on low stock" or "tag high-value orders."

### v1.0.0 -- Production Hardening

Multi-store management allows a single MCP server to handle multiple Shopify stores with per-store auth and config. Achieves full Shopify Admin GraphQL API coverage across all resource types. A plugin system enables third-party extensions beyond YAML custom tools.

### v2.0.0 -- Hosted MCP-as-a-Service

A hosted multi-tenant version where merchants connect via browser OAuth without managing infrastructure. Includes an admin dashboard for monitoring API usage, managing tools, and viewing audit logs. Billing integration supports usage-based pricing for the hosted service.

---

## FAQ

### What Shopify scopes do I need?

At minimum for full functionality:

- `read_products`, `write_products`
- `read_orders`, `write_orders`
- `read_customers`, `write_customers`
- `read_inventory`, `write_inventory`
- `read_reports` (required for all 16 analytics tools)
- `read_locations`
- `read_assigned_fulfillment_orders`, `write_assigned_fulfillment_orders`
- `write_draft_orders`

If you only need read operations, you can omit the `write_*` scopes and enable `read_only: true` in config.

### How does rate limiting work?

cob-shopify-mcp uses **cost-based rate limiting**, not simple request counting. Shopify's Admin API returns a cost bucket in each response's `extensions.cost` field, showing how many points were consumed and how many remain. The rate limiter reads this data and automatically waits when the bucket is low, preventing throttling errors. You can configure `max_concurrent` to limit parallel requests (default: 10).

### Can I add custom tools?

Yes. Create a YAML file that defines the tool's name, domain, description, input schema, GraphQL query/mutation, and response mapping. Point your config at the directory:

```yaml
tools:
  custom_paths:
    - ./my-custom-tools
```

Custom tools auto-register as both MCP tools and CLI commands under their declared domain. See the `custom-tools/` directory in the repository for working examples.

### What is Advertise-and-Activate?

A context reduction feature for MCP connections. Instead of sending all 59 tool schemas to the AI agent (which consumes significant context window), it registers a single `activate_tools` meta-tool that describes available domains. The AI calls `activate_tools("products")` to load only the tools it needs. This reduces initial token usage by 82%. Enable it with `tools.advertise_and_activate: true` in config or `COB_SHOPIFY_ADVERTISE_AND_ACTIVATE=true` env var.

### CLI vs MCP -- when should I use which?

**Use the CLI** (`cob-shopify`) for:
- Shell scripts and CI/CD pipelines
- Quick one-off lookups ("what's the status of order #1042?")
- Data exports with `--json` and `--jq` flags
- Dry-run previews of mutations with `--dry-run`

**Use MCP** for:
- AI agents that need to query and act on Shopify data
- Chatbots and conversational interfaces
- Multi-step automation where an LLM decides the next action
- Integration with Claude, Cursor, Windsurf, or other MCP-compatible clients

Both modes use the same tool definitions, auth, and config -- they are two interfaces to the same engine.

### How do I run in Docker?

```bash
git clone https://github.com/svinpeace/cob-shopify-mcp.git
cd cob-shopify-mcp
cp .env.example .env  # Add your credentials
docker compose up -d
```

This starts the HTTP transport on port 3000. Connect via:

```bash
claude mcp add --transport http cob-shopify-mcp http://127.0.0.1:3000/mcp
```

Verify with `curl http://127.0.0.1:3000/health`.

### Does it work with Cursor and Windsurf?

Yes. Both Cursor and Windsurf support MCP. Add the server to your editor's MCP configuration file:

**Cursor** -- `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "cob-shopify-mcp": {
      "command": "npx",
      "args": ["cob-shopify-mcp", "start"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "your-store.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

**Windsurf** -- use the same JSON structure in Windsurf's MCP settings.
