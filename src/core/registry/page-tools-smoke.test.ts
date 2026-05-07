import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadYamlTools } from "./yaml-loader.js";

const CUSTOM_TOOLS_DIR = new URL("../../../custom-tools/", import.meta.url).pathname;

describe("page-management custom tools smoke test", () => {
	const tools = loadYamlTools([CUSTOM_TOOLS_DIR]);
	const byName = new Map(tools.map((t) => [t.name, t]));

	it("loads page_create with correct shape", () => {
		const t = byName.get("page_create");
		expect(t).toBeDefined();
		expect(t?.domain).toBe("products");
		expect(t?.tier).toBe(3);
		expect(t?.scopes).toContain("write_content");
		expect(Object.keys(t!.input)).toEqual(
			expect.arrayContaining(["title", "body_html", "handle", "template_suffix", "published"]),
		);
		const parsed = z.object(t!.input).parse({ title: "Test" });
		expect(parsed.title).toBe("Test");
		expect((parsed as any).body_html).toBe("");
		expect((parsed as any).published).toBe(true);
		expect(t!.graphql).toMatch(/mutation PageCreate/);
		expect(t!.graphql).toMatch(/pageCreate\(/);
	});

	it("loads page_update with correct shape", () => {
		const t = byName.get("page_update");
		expect(t).toBeDefined();
		expect(t?.scopes).toContain("write_content");
		expect(Object.keys(t!.input)).toEqual(
			expect.arrayContaining(["id", "title", "body_html", "handle", "template_suffix", "published"]),
		);
		const parsed = z.object(t!.input).parse({ id: "gid://shopify/Page/1" });
		expect(parsed.id).toBe("gid://shopify/Page/1");
		expect(t!.graphql).toMatch(/mutation PageUpdate/);
		expect(t!.graphql).toMatch(/pageUpdate\(/);
	});

	it("loads list_pages with default limit 50", () => {
		const t = byName.get("list_pages");
		expect(t).toBeDefined();
		expect(t?.scopes).toContain("read_content");
		const parsed = z.object(t!.input).parse({});
		expect((parsed as any).limit).toBe(50);
		expect(t!.graphql).toMatch(/query ListPages/);
		expect(t!.graphql).toMatch(/pages\(first:/);
	});

	it("loads redirect_create with path + target", () => {
		const t = byName.get("redirect_create");
		expect(t).toBeDefined();
		expect(t?.scopes).toContain("write_online_store_pages");
		expect(Object.keys(t!.input)).toEqual(["path", "target"]);
		const parsed = z.object(t!.input).parse({ path: "/llms.txt", target: "/pages/llms-txt" });
		expect(parsed.path).toBe("/llms.txt");
		expect(parsed.target).toBe("/pages/llms-txt");
		expect(t!.graphql).toMatch(/mutation UrlRedirectCreate/);
		expect(t!.graphql).toMatch(/urlRedirectCreate\(/);
	});
});
