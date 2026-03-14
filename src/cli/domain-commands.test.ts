import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "../core/engine/types.js";
import { buildDomainCommands } from "./domain-commands.js";
import { domainDescriptions, getDomainDescription } from "./domain-descriptions.js";

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "list_products",
		domain: "products",
		tier: 1,
		description: "List products from the store",
		scopes: ["read_products"],
		input: {
			limit: z.number().describe("Max items to return").default(10),
		},
		handler: async (input) => ({ products: [], count: 0, limit: input.limit }),
		...overrides,
	};
}

describe("domainDescriptions", () => {
	it("has descriptions for all built-in domains", () => {
		expect(domainDescriptions.products).toBeDefined();
		expect(domainDescriptions.orders).toBeDefined();
		expect(domainDescriptions.customers).toBeDefined();
		expect(domainDescriptions.inventory).toBeDefined();
		expect(domainDescriptions.analytics).toBeDefined();
	});
});

describe("getDomainDescription", () => {
	it("returns hardcoded description for known domains", () => {
		expect(getDomainDescription("products")).toBe("Manage products, variants, collections");
	});

	it("returns auto-generated description for unknown domains", () => {
		expect(getDomainDescription("shipping")).toBe("Tools for shipping");
	});
});

describe("buildDomainCommands", () => {
	it("groups tools by domain into parent commands", () => {
		const tools = [
			makeTool({ name: "list_products", domain: "products" }),
			makeTool({ name: "get_product", domain: "products" }),
			makeTool({ name: "list_orders", domain: "orders" }),
		];

		const commands = buildDomainCommands(tools);

		expect(commands).toHaveLength(2);
		const names = commands.map((c) => c.name());
		expect(names).toContain("products");
		expect(names).toContain("orders");
	});

	it("creates correct subcommands per domain", () => {
		const tools = [
			makeTool({ name: "list_products", domain: "products" }),
			makeTool({ name: "get_product", domain: "products" }),
		];

		const commands = buildDomainCommands(tools);
		const productsCmd = commands.find((c) => c.name() === "products");

		expect(productsCmd).toBeDefined();
		const subCmdNames = productsCmd?.commands.map((c) => c.name());
		expect(subCmdNames).toContain("list");
		expect(subCmdNames).toContain("get");
	});

	it("applies domain description from domainDescriptions", () => {
		const tools = [makeTool({ name: "list_products", domain: "products" })];

		const commands = buildDomainCommands(tools);
		const productsCmd = commands.find((c) => c.name() === "products");

		expect(productsCmd?.description()).toBe("Manage products, variants, collections");
	});

	it("auto-generates description for custom domains", () => {
		const tools = [makeTool({ name: "list_shipping_zones", domain: "shipping", tier: 3 })];

		const commands = buildDomainCommands(tools);
		const shippingCmd = commands.find((c) => c.name() === "shipping");

		expect(shippingCmd?.description()).toBe("Tools for shipping");
	});

	it("sets domain name as command name", () => {
		const tools = [makeTool({ name: "list_orders", domain: "orders" })];

		const commands = buildDomainCommands(tools);
		const ordersCmd = commands.find((c) => c.name() === "orders");

		expect(ordersCmd?.name()).toBe("orders");
	});

	it("derives action names correctly from tool names", () => {
		const tools = [
			makeTool({ name: "create_product", domain: "products" }),
			makeTool({ name: "update_product_variant", domain: "products" }),
		];

		const commands = buildDomainCommands(tools);
		const productsCmd = commands.find((c) => c.name() === "products");
		const subCmdNames = productsCmd?.commands.map((c) => c.name());

		expect(subCmdNames).toContain("create");
		expect(subCmdNames).toContain("update-variant");
	});

	it("returns empty array for empty tools array", () => {
		const commands = buildDomainCommands([]);
		expect(commands).toHaveLength(0);
	});

	it("handles tools with multiple domains correctly", () => {
		const tools = [
			makeTool({ name: "list_products", domain: "products" }),
			makeTool({ name: "list_orders", domain: "orders" }),
			makeTool({ name: "list_customers", domain: "customers" }),
			makeTool({ name: "adjust_inventory", domain: "inventory" }),
		];

		const commands = buildDomainCommands(tools);
		const names = commands.map((c) => c.name()).sort();

		expect(names).toEqual(["customers", "inventory", "orders", "products"]);
	});
});
