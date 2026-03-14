import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CobConfig } from "../config/types.js";
import { ToolRegistry } from "../registry/tool-registry.js";
import { buildAdvertisementDescription, createActivateHandler } from "./advertiser.js";
import type { ToolDefinition } from "./types.js";

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "test_tool",
		domain: "products",
		tier: 1,
		description: "A test tool",
		scopes: ["read_products"],
		input: {},
		graphql: "query { products { id } }",
		...overrides,
	};
}

function makeConfig(overrides: Partial<CobConfig["tools"]> = {}): CobConfig {
	return {
		auth: { method: "token", store_domain: "test.myshopify.com", access_token: "shpat_test" },
		shopify: { api_version: "2025-01", max_retries: 3, cache: { read_ttl: 300, search_ttl: 60, analytics_ttl: 900 } },
		tools: { read_only: false, disable: [], enable: [], custom_paths: [], advertise_and_activate: true, ...overrides },
		transport: { type: "stdio", port: 3000, host: "localhost" },
		storage: { backend: "json", path: "./data", encrypt_tokens: false },
		observability: { log_level: "info", audit_log: false, metrics: false },
		rate_limit: { respect_shopify_cost: true, max_concurrent: 5 },
	};
}

describe("buildAdvertisementDescription", () => {
	it("includes all domains with correct tool counts", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool({ name: "list_products", domain: "products" }));
		registry.register(makeTool({ name: "get_product", domain: "products" }));
		registry.register(makeTool({ name: "list_orders", domain: "orders", scopes: ["read_orders"] }));

		const desc = buildAdvertisementDescription(registry, makeConfig());
		expect(desc).toContain("products (2 tools)");
		expect(desc).toContain("orders (1 tool)");
	});

	it("omits domains with zero enabled tools", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool({ name: "list_products", domain: "products" }));
		registry.register(makeTool({ name: "tier2_tool", domain: "billing", tier: 2 }));

		const desc = buildAdvertisementDescription(registry, makeConfig());
		expect(desc).toContain("products");
		expect(desc).not.toContain("billing");
	});

	it("respects read_only by excluding write-scope tools from counts", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool({ name: "list_products", domain: "products", scopes: ["read_products"] }));
		registry.register(makeTool({ name: "create_product", domain: "products", scopes: ["write_products"] }));

		const desc = buildAdvertisementDescription(registry, makeConfig({ read_only: true }));
		expect(desc).toContain("products (1 tool)");
	});

	it("includes custom YAML tools in their declared domain", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool({ name: "list_orders", domain: "orders", scopes: ["read_orders"] }));
		registry.register(makeTool({ name: "custom_order_tool", domain: "orders", tier: 3, scopes: ["read_orders"] }));

		const desc = buildAdvertisementDescription(registry, makeConfig());
		expect(desc).toContain("orders (2 tools)");
		expect(desc).toContain("custom_order_tool");
	});

	it("lists tool names in each domain summary", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool({ name: "list_products", domain: "products" }));
		registry.register(makeTool({ name: "get_product", domain: "products" }));

		const desc = buildAdvertisementDescription(registry, makeConfig());
		expect(desc).toContain("list_products");
		expect(desc).toContain("get_product");
	});

	it("includes usage instructions", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool({ name: "list_products", domain: "products" }));

		const desc = buildAdvertisementDescription(registry, makeConfig());
		expect(desc).toContain("activate_tools");
	});
});

describe("createActivateHandler", () => {
	let registry: ToolRegistry;
	let config: CobConfig;
	let serverToolCalls: Array<{ name: string }>;
	let mockServer: { tool: (...args: any[]) => void };

	beforeEach(() => {
		registry = new ToolRegistry();
		config = makeConfig();
		serverToolCalls = [];
		mockServer = {
			tool: vi.fn((...args: any[]) => {
				serverToolCalls.push({ name: args[0] });
			}),
		};
	});

	it("activates a single domain by string", async () => {
		registry.register(makeTool({ name: "sales_summary", domain: "analytics", scopes: ["read_analytics"] }));
		registry.register(makeTool({ name: "top_products", domain: "analytics", scopes: ["read_analytics"] }));

		const handler = createActivateHandler(mockServer as any, registry, config, {} as any, {} as any);
		const result = await handler({ domains: "analytics" });

		expect(result.activated).toContain("analytics");
		expect(result.tools).toHaveLength(2);
		expect(serverToolCalls).toHaveLength(2);
	});

	it("activates multiple domains by array", async () => {
		registry.register(makeTool({ name: "list_products", domain: "products" }));
		registry.register(makeTool({ name: "list_orders", domain: "orders", scopes: ["read_orders"] }));

		const handler = createActivateHandler(mockServer as any, registry, config, {} as any, {} as any);
		const result = await handler({ domains: ["products", "orders"] });

		expect(result.activated).toContain("products");
		expect(result.activated).toContain("orders");
		expect(serverToolCalls).toHaveLength(2);
	});

	it("returns tool list on re-activation without double-registering", async () => {
		registry.register(makeTool({ name: "sales_summary", domain: "analytics", scopes: ["read_analytics"] }));

		const handler = createActivateHandler(mockServer as any, registry, config, {} as any, {} as any);
		await handler({ domains: "analytics" });
		const result = await handler({ domains: "analytics" });

		expect(result.already_active).toContain("analytics");
		expect(result.tools).toHaveLength(1);
		expect(serverToolCalls).toHaveLength(1);
	});

	it("returns error for unknown domain", async () => {
		registry.register(makeTool({ name: "list_products", domain: "products" }));

		const handler = createActivateHandler(mockServer as any, registry, config, {} as any, {} as any);
		const result = await handler({ domains: "nonexistent" });

		expect(result.error).toContain("Unknown domain");
		expect(result.error).toContain("nonexistent");
		expect(result.error).toContain("products");
	});

	it("handles mixed valid and already-active domains", async () => {
		registry.register(makeTool({ name: "list_products", domain: "products" }));
		registry.register(makeTool({ name: "list_orders", domain: "orders", scopes: ["read_orders"] }));

		const handler = createActivateHandler(mockServer as any, registry, config, {} as any, {} as any);
		await handler({ domains: "products" });
		const result = await handler({ domains: ["products", "orders"] });

		expect(result.activated).toContain("orders");
		expect(result.already_active).toContain("products");
	});

	it("includes brief descriptions in activation response", async () => {
		registry.register(
			makeTool({
				name: "sales_summary",
				domain: "analytics",
				description: "Get sales totals for a date range",
				scopes: ["read_analytics"],
			}),
		);

		const handler = createActivateHandler(mockServer as any, registry, config, {} as any, {} as any);
		const result = await handler({ domains: "analytics" });

		expect(result.tools[0]).toContain("sales_summary");
		expect(result.tools[0]).toContain("Get sales totals");
	});
});
