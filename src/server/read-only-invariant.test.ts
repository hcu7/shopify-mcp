import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CobConfig } from "@core/config/types.js";
import { ToolRegistry } from "@core/registry/tool-registry.js";
import { loadYamlTools } from "@core/registry/yaml-loader.js";
import { describe, expect, it } from "vitest";
import { getAllTools } from "./get-all-tools.js";

/**
 * Security invariant for read-only deployments (COB_SHOPIFY_READ_ONLY=true):
 *
 * 1. No tool whose GraphQL contains a mutation is exposed in read-only mode.
 * 2. Pure-query tools must not declare write_ scopes — otherwise the
 *    scope-based read-only filter hides them by mistake (regression guard for
 *    order_returns / return_reverse_fulfillment_orders, which declared
 *    write_returns despite being plain queries).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CUSTOM_TOOLS_DIR = join(REPO_ROOT, "custom-tools");
const BUILTIN_TOOLS_DIR = join(REPO_ROOT, "src/shopify/tools");

const MUTATION_RE = /(^|\n)\s*mutation[\s({]/;

function isMutation(graphql: string): boolean {
	return MUTATION_RE.test(graphql);
}

function makeConfig(toolOverrides: Partial<CobConfig["tools"]>): CobConfig {
	return {
		auth: { method: "token", store_domain: "test.myshopify.com", access_token: "shpat_test" },
		shopify: { api_version: "2025-01", max_retries: 3, cache: { read_ttl: 60, search_ttl: 30, analytics_ttl: 300 } },
		tools: { read_only: false, disable: [], enable: [], custom_paths: [], ...toolOverrides },
		transport: { type: "stdio", port: 3000, host: "0.0.0.0" },
		storage: { backend: "json", path: "~/.cob-shopify-mcp/data.json", encrypt_tokens: false },
		observability: { log_level: "info", audit_log: false, metrics: false },
		rate_limit: { respect_shopify_cost: true, max_concurrent: 4 },
	} as CobConfig;
}

function buildFullRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	for (const tool of getAllTools()) registry.register(tool);
	for (const tool of loadYamlTools([CUSTOM_TOOLS_DIR])) registry.register(tool);
	return registry;
}

function collectGraphqlFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith("_")) continue; // _disabled (tier 2 sources)
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectGraphqlFiles(full));
		} else if (entry.name.endsWith(".graphql")) {
			files.push(full);
		}
	}
	return files;
}

function extractScopes(toolTsSource: string): string[] {
	const match = toolTsSource.match(/scopes:\s*\[([^\]]*)\]/);
	if (!match) return [];
	return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("read-only mode security invariant", () => {
	const registry = buildFullRegistry();
	const roTools = registry.filter(makeConfig({ read_only: true }));
	const roNames = new Set(roTools.map((t) => t.name));

	it("registers custom YAML tools alongside built-ins", () => {
		expect(registry.getAll().length).toBeGreaterThan(60);
		expect(roTools.length).toBeGreaterThan(0);
	});

	it("exposes NO tool with a GraphQL mutation in read-only mode", () => {
		const offenders = roTools.filter((t) => t.graphql && isMutation(t.graphql)).map((t) => t.name);
		expect(offenders).toEqual([]);
	});

	it("filters every mutation-carrying tool definition out of read-only mode", () => {
		const mutationTools = registry
			.getAll()
			.filter((t) => t.graphql && isMutation(t.graphql))
			.map((t) => t.name);
		expect(mutationTools.length).toBeGreaterThan(0);
		for (const name of mutationTools) {
			expect(roNames.has(name), `mutation tool "${name}" must not be visible in read-only mode`).toBe(false);
		}
	});

	it("exposes no tool with write_ scopes in read-only mode", () => {
		const offenders = roTools.filter((t) => t.scopes.some((s) => s.startsWith("write_"))).map((t) => t.name);
		expect(offenders).toEqual([]);
	});

	it("keeps the read-only returns/backoffice tools available in read-only mode", () => {
		expect(roNames.has("order_returns")).toBe(true);
		expect(roNames.has("return_reverse_fulfillment_orders")).toBe(true);
		expect(roNames.has("orders_returns_bulk")).toBe(true);
		expect(roNames.has("get_order")).toBe(true);
	});
});

describe("scope declarations match GraphQL operation type (source scan)", () => {
	it("custom-tools YAML: mutations carry write_ scopes, queries carry none", () => {
		const yamlTools = loadYamlTools([CUSTOM_TOOLS_DIR]);
		expect(yamlTools.length).toBeGreaterThan(0);
		for (const tool of yamlTools) {
			const graphql = tool.graphql ?? "";
			const hasWriteScope = tool.scopes.some((s) => s.startsWith("write_"));
			if (isMutation(graphql)) {
				expect(hasWriteScope, `mutation tool "${tool.name}" needs a write_ scope (else visible in read-only!)`).toBe(
					true,
				);
			} else {
				expect(
					hasWriteScope,
					`query tool "${tool.name}" must not declare write_ scopes (else hidden in read-only!)`,
				).toBe(false);
			}
		}
	});

	it("built-in tools: mutation .graphql files pair with write_-scoped tools, query files with read-only scopes", () => {
		const graphqlFiles = collectGraphqlFiles(BUILTIN_TOOLS_DIR);
		expect(graphqlFiles.length).toBeGreaterThan(0);
		for (const graphqlFile of graphqlFiles) {
			const toolFile = graphqlFile.replace(/\.graphql$/, ".tool.ts");
			expect(existsSync(toolFile), `missing co-located tool file for ${graphqlFile}`).toBe(true);
			const graphql = readFileSync(graphqlFile, "utf-8");
			const scopes = extractScopes(readFileSync(toolFile, "utf-8"));
			expect(scopes.length, `no scopes found in ${toolFile}`).toBeGreaterThan(0);
			const hasWriteScope = scopes.some((s) => s.startsWith("write_"));
			if (isMutation(graphql)) {
				expect(hasWriteScope, `mutation tool ${toolFile} needs a write_ scope (else visible in read-only!)`).toBe(true);
			} else {
				expect(hasWriteScope, `query tool ${toolFile} must not declare write_ scopes (else hidden in read-only!)`).toBe(
					false,
				);
			}
		}
	});
});
