import type { ExecutionContext } from "@core/engine/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ordersReturnsBulk } from "./orders-returns-bulk.tool.js";

function makeCtx(queryFn = vi.fn()): ExecutionContext {
	return {
		shopify: { query: queryFn },
		config: {} as any,
		storage: {} as any,
		logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any,
		costTracker: {} as any,
	};
}

function orderNode(overrides: Record<string, unknown> = {}) {
	return {
		id: "gid://shopify/Order/1",
		name: "#1001",
		returnStatus: "RETURN_REQUESTED",
		displayFinancialStatus: "PAID",
		displayFulfillmentStatus: "FULFILLED",
		cancelledAt: null,
		returns: { nodes: [{ id: "gid://shopify/Return/1", name: "#1001-R1", status: "REQUESTED" }] },
		...overrides,
	};
}

const schema = z.object(ordersReturnsBulk.input);

describe("orders_returns_bulk", () => {
	it("has correct tool definition (read-only)", () => {
		expect(ordersReturnsBulk.name).toBe("orders_returns_bulk");
		expect(ordersReturnsBulk.domain).toBe("orders");
		expect(ordersReturnsBulk.tier).toBe(1);
		expect(ordersReturnsBulk.scopes).toEqual(["read_orders", "read_returns"]);
		expect(ordersReturnsBulk.scopes.every((s) => s.startsWith("read_"))).toBe(true);
	});

	it("query is a pure GraphQL query (no mutation)", async () => {
		const queryFn = vi.fn().mockResolvedValue({ orders: { nodes: [], pageInfo: { hasNextPage: false } } });
		await ordersReturnsBulk.handler?.({ updated_at_min: "2026-06-01", first: 50 }, makeCtx(queryFn));
		const graphql = queryFn.mock.calls[0][0] as string;
		expect(graphql.trimStart().startsWith("query")).toBe(true);
		expect(graphql).not.toMatch(/(^|\n)\s*mutation[\s({]/);
	});

	describe("parameter validation", () => {
		it("rejects when neither updated_at_min nor order_ids is given", async () => {
			await expect(ordersReturnsBulk.handler?.({ first: 50 }, makeCtx())).rejects.toThrow(
				/exactly one of updated_at_min or order_ids/i,
			);
		});

		it("rejects when both updated_at_min and order_ids are given", async () => {
			await expect(
				ordersReturnsBulk.handler?.({ updated_at_min: "2026-06-01", order_ids: ["1"], first: 50 }, makeCtx()),
			).rejects.toThrow(/exactly one of updated_at_min or order_ids/i);
		});

		it("rejects non-ISO updated_at_min at schema level", () => {
			expect(schema.safeParse({ updated_at_min: "gestern" }).success).toBe(false);
			expect(schema.safeParse({ updated_at_min: "updated_at:>=1' OR 1" }).success).toBe(false);
			expect(schema.safeParse({ updated_at_min: "2026-06-01" }).success).toBe(true);
			expect(schema.safeParse({ updated_at_min: "2026-06-01T12:30:00Z" }).success).toBe(true);
			expect(schema.safeParse({ updated_at_min: "2026-06-01T12:30:00+02:00" }).success).toBe(true);
		});

		it("enforces first bounds (1..250) and defaults to 50", () => {
			expect(schema.safeParse({ updated_at_min: "2026-06-01", first: 0 }).success).toBe(false);
			expect(schema.safeParse({ updated_at_min: "2026-06-01", first: 251 }).success).toBe(false);
			const parsed = schema.parse({ updated_at_min: "2026-06-01" });
			expect(parsed.first).toBe(50);
		});

		it("enforces order_ids bounds (1..250 entries)", () => {
			expect(schema.safeParse({ order_ids: [] }).success).toBe(false);
			expect(schema.safeParse({ order_ids: Array.from({ length: 251 }, (_, i) => i + 1) }).success).toBe(false);
			expect(schema.safeParse({ order_ids: ["1", 2, "gid://shopify/Order/3"] }).success).toBe(true);
		});

		it("rejects malformed order ids in the handler", async () => {
			await expect(
				ordersReturnsBulk.handler?.({ order_ids: ["gid://shopify/Product/1"], first: 50 }, makeCtx()),
			).rejects.toThrow(/Invalid order id/);
			await expect(ordersReturnsBulk.handler?.({ order_ids: ["abc"], first: 50 }, makeCtx())).rejects.toThrow(
				/Invalid order id/,
			);
		});
	});

	describe("updated_at_min sweep mode", () => {
		it("builds the updated_at search query and passes pagination variables", async () => {
			const queryFn = vi.fn().mockResolvedValue({
				orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
			});
			await ordersReturnsBulk.handler?.(
				{ updated_at_min: "2026-06-01T00:00:00Z", first: 100, cursor: "abc" },
				makeCtx(queryFn),
			);
			expect(queryFn).toHaveBeenCalledWith(expect.any(String), {
				first: 100,
				cursor: "abc",
				search_query: "updated_at:>='2026-06-01T00:00:00Z'",
				order_ids: [],
				sweep: true,
				by_ids: false,
			});
		});

		it("filters out orders with returnStatus NO_RETURN but reports scannedCount", async () => {
			const queryFn = vi.fn().mockResolvedValue({
				orders: {
					nodes: [
						orderNode(),
						orderNode({
							id: "gid://shopify/Order/2",
							name: "#1002",
							returnStatus: "NO_RETURN",
							returns: { nodes: [] },
						}),
						orderNode({ id: "gid://shopify/Order/3", name: "#1003", returnStatus: "RETURNED" }),
					],
					pageInfo: { hasNextPage: true, endCursor: "cursor-3" },
				},
			});
			const result = await ordersReturnsBulk.handler?.({ updated_at_min: "2026-06-01", first: 50 }, makeCtx(queryFn));
			expect(result.mode).toBe("updated_at_sweep");
			expect(result.scannedCount).toBe(3);
			expect(result.orders.map((o: any) => o.name)).toEqual(["#1001", "#1003"]);
			expect(result.pageInfo).toEqual({ hasNextPage: true, endCursor: "cursor-3" });
		});

		it("maps order fields including cancelledAt and flattened returns", async () => {
			const queryFn = vi.fn().mockResolvedValue({
				orders: {
					nodes: [orderNode({ cancelledAt: "2026-06-15T09:00:00Z" })],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			});
			const result = await ordersReturnsBulk.handler?.({ updated_at_min: "2026-06-01", first: 50 }, makeCtx(queryFn));
			expect(result.orders[0]).toEqual({
				id: "gid://shopify/Order/1",
				name: "#1001",
				returnStatus: "RETURN_REQUESTED",
				displayFinancialStatus: "PAID",
				displayFulfillmentStatus: "FULFILLED",
				cancelledAt: "2026-06-15T09:00:00Z",
				returns: [{ id: "gid://shopify/Return/1", name: "#1001-R1", status: "REQUESTED" }],
			});
		});

		it("unwraps a { data: ... } envelope", async () => {
			const queryFn = vi.fn().mockResolvedValue({
				data: { orders: { nodes: [orderNode()], pageInfo: { hasNextPage: false, endCursor: null } } },
			});
			const result = await ordersReturnsBulk.handler?.({ updated_at_min: "2026-06-01", first: 50 }, makeCtx(queryFn));
			expect(result.orders).toHaveLength(1);
		});
	});

	describe("order_ids mode", () => {
		it("normalizes numeric ids to GIDs and does not filter by returnStatus", async () => {
			const queryFn = vi.fn().mockResolvedValue({
				nodes: [orderNode({ returnStatus: "NO_RETURN", returns: { nodes: [] } })],
			});
			const result = await ordersReturnsBulk.handler?.({ order_ids: [1], first: 50 }, makeCtx(queryFn));
			expect(queryFn).toHaveBeenCalledWith(expect.any(String), {
				first: 50,
				order_ids: ["gid://shopify/Order/1"],
				sweep: false,
				by_ids: true,
			});
			expect(result.mode).toBe("order_ids");
			expect(result.orders).toHaveLength(1);
			expect(result.orders[0].returnStatus).toBe("NO_RETURN");
		});

		it("accepts full GIDs unchanged", async () => {
			const queryFn = vi.fn().mockResolvedValue({ nodes: [orderNode()] });
			await ordersReturnsBulk.handler?.({ order_ids: ["gid://shopify/Order/42"], first: 50 }, makeCtx(queryFn));
			expect(queryFn.mock.calls[0][1].order_ids).toEqual(["gid://shopify/Order/42"]);
		});

		it("reports not-found ids (null nodes) separately", async () => {
			const queryFn = vi.fn().mockResolvedValue({ nodes: [orderNode(), null] });
			const result = await ordersReturnsBulk.handler?.({ order_ids: ["1", "999"], first: 50 }, makeCtx(queryFn));
			expect(result.orders).toHaveLength(1);
			expect(result.notFound).toEqual(["gid://shopify/Order/999"]);
		});
	});
});
