# Getting Started

## Installation

### npm (recommended)

Install globally for CLI access:

```bash
npm install -g cob-shopify-mcp
```

Or use `npx` to run without installing:

```bash
npx cob-shopify-mcp start
```

### Docker

```bash
git clone https://github.com/svinpeace/cob-shopify-mcp.git
cd cob-shopify-mcp
docker compose up -d
```

The HTTP transport runs on port 3000. Verify with:

```bash
curl http://127.0.0.1:3000/health
# {"status":"ok"}
```

## Shopify Credentials

cob-shopify-mcp uses **OAuth Client Credentials** (recommended) to authenticate with the Shopify Admin API.

### Step 1: Create a Shopify App

1. Go to [Shopify Partners](https://partners.shopify.com/) and log in
2. Navigate to **Apps** > **Create app**
3. Choose **Create app manually**
4. Name your app and click **Create**

### Step 2: Configure Scopes

Under **Configuration** > **Admin API access scopes**, enable:

- `read_products`, `write_products`
- `read_orders`, `write_orders`
- `read_customers`, `write_customers`
- `read_inventory`, `write_inventory`
- `read_reports` (required for analytics/ShopifyQL tools)
- `read_locations`
- `read_assigned_fulfillment_orders`, `write_assigned_fulfillment_orders`
- `write_draft_orders`

### Step 3: Install on Your Store

1. Under **Distribution**, choose **Custom distribution**
2. Install the app on your development or production store
3. After installation, you will receive an **access token**

### Step 4: Set Environment Variables

Create a `.env` file in your project root (or set these as environment variables):

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxx
```

Or, for client credentials flow:

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
COB_SHOPIFY_CLIENT_ID=your-client-id
COB_SHOPIFY_CLIENT_SECRET=your-client-secret
```

## First CLI Command

List your first 5 products:

```bash
cob-shopify products list --limit 5
```

Get JSON output for scripting:

```bash
cob-shopify products list --limit 5 --json
```

Filter specific fields:

```bash
cob-shopify products list --limit 5 --fields id,title,status
```

View a tool's input schema without executing:

```bash
cob-shopify products list --schema
```

Preview a mutation without executing it:

```bash
cob-shopify products create --title "Test Product" --dry-run
```

## Connect to MCP

### Claude Code / Claude Desktop

Add the MCP server:

```bash
claude mcp add cob-shopify-mcp -- npx cob-shopify-mcp start
```

Then type `/mcp` in Claude to verify the connection. You should see `cob-shopify-mcp` listed with its tools.

### Claude Desktop (JSON config)

Add to your `claude_desktop_config.json`:

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

### Cursor

Add to `.cursor/mcp.json` in your project root:

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

### Windsurf

Add to your Windsurf MCP configuration:

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

### Docker (HTTP transport)

If running via Docker, use HTTP transport:

```bash
claude mcp add --transport http cob-shopify-mcp http://127.0.0.1:3000/mcp
```
