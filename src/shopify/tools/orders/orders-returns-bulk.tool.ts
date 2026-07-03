import { defineTool } from "@core/helpers/define-tool.js";
import { z } from "zod";
import query from "./orders-returns-bulk.graphql";

// ISO 8601: date or datetime with optional fractional seconds and offset.
// Strict on purpose — the value is embedded into a Shopify search query string.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/;

const ORDER_GID_PREFIX = "gid://shopify/Order/";

function normalizeOrderId(id: string | number): string {
	const value = String(id).trim();
	if (/^\d+$/.test(value)) return `${ORDER_GID_PREFIX}${value}`;
	if (value.startsWith(ORDER_GID_PREFIX) && /^\d+$/.test(value.slice(ORDER_GID_PREFIX.length))) return value;
	throw new Error(`Invalid order id "${value}" — expected a numeric id or a ${ORDER_GID_PREFIX}<id> GID`);
}

function mapOrder(node: any) {
	return {
		id: node.id,
		name: node.name,
		returnStatus: node.returnStatus,
		displayFinancialStatus: node.displayFinancialStatus,
		displayFulfillmentStatus: node.displayFulfillmentStatus,
		cancelledAt: node.cancelledAt,
		returns: node.returns?.nodes ?? [],
	};
}

export const ordersReturnsBulk = defineTool({
	name: "orders_returns_bulk",
	domain: "orders",
	tier: 1,
	description:
		"Bulk return-status lookup across orders (read-only). Exactly one of updated_at_min / order_ids is required. " +
		"Mode (a) updated_at_min (ISO 8601): pages through orders updated since that time (use cursor from pageInfo) " +
		"and returns only orders with return activity (returnStatus != NO_RETURN); scannedCount reports the raw page size. " +
		"Mode (b) order_ids (numeric ids or gid://shopify/Order/... GIDs, max 250): fetches exactly those orders, unfiltered. " +
		"Per order: id, name, returnStatus, displayFinancialStatus, displayFulfillmentStatus, cancelledAt, returns (id, name, status).",
	scopes: ["read_orders", "read_returns"],
	input: {
		updated_at_min: z
			.string()
			.regex(ISO_8601, "Must be an ISO 8601 date or datetime, e.g. 2026-06-01 or 2026-06-01T00:00:00Z")
			.optional(),
		order_ids: z
			.array(z.union([z.string(), z.number()]))
			.min(1)
			.max(250)
			.optional(),
		first: z.coerce.number().min(1).max(250).default(50),
		cursor: z.string().optional(),
	},
	handler: async (input, ctx) => {
		const hasSweep = input.updated_at_min !== undefined;
		const hasIds = input.order_ids !== undefined;
		if (hasSweep === hasIds) {
			throw new Error("Provide exactly one of updated_at_min or order_ids");
		}

		if (hasIds) {
			const gids: string[] = input.order_ids.map(normalizeOrderId);
			const result = await ctx.shopify.query(query, {
				first: input.first,
				order_ids: gids,
				sweep: false,
				by_ids: true,
			});
			const data = result.data ?? result;
			const nodes: any[] = data.nodes ?? [];
			const orders: any[] = [];
			const notFound: string[] = [];
			gids.forEach((gid, i) => {
				const node = nodes[i];
				if (node?.id) {
					orders.push(mapOrder(node));
				} else {
					notFound.push(gid);
				}
			});
			return { mode: "order_ids", orders, notFound };
		}

		// Sweep mode. returnStatus is filtered client-side instead of via the
		// return_status search filter: search indexes update asynchronously, the
		// direct field read is authoritative — a sync worker must not miss orders.
		const result = await ctx.shopify.query(query, {
			first: input.first,
			cursor: input.cursor,
			search_query: `updated_at:>='${input.updated_at_min}'`,
			order_ids: [],
			sweep: true,
			by_ids: false,
		});
		const data = result.data ?? result;
		const connection = data.orders ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
		const scanned: any[] = connection.nodes ?? [];
		const orders = scanned.map(mapOrder).filter((order) => order.returnStatus !== "NO_RETURN");
		return {
			mode: "updated_at_sweep",
			scannedCount: scanned.length,
			orders,
			pageInfo: connection.pageInfo,
		};
	},
});
