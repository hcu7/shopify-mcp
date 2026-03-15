import type { ExecutionContext } from "@core/engine/types.js";
import { defineTool } from "@core/helpers/define-tool.js";
import { executeShopifyQL } from "@shopify/client/shopifyql-client.js";
import { z } from "zod";

export default defineTool({
	name: "conversion_funnel",
	domain: "analytics",
	tier: 1,
	description: "Conversion funnel metrics: sessions, orders, and derived conversion rate (values in shop currency)",
	scopes: ["read_reports"],
	input: {
		start_date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
			.describe("ISO 8601 date, e.g. 2026-01-01"),
		end_date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
			.describe("ISO 8601 date, e.g. 2026-01-31"),
	},
	handler: async (input: { start_date: string; end_date: string }, ctx: ExecutionContext) => {
		const [salesResult, sessionsResult] = await Promise.all([
			executeShopifyQL(
				`FROM sales SHOW orders, total_sales, customers SINCE ${input.start_date} UNTIL ${input.end_date}`,
				ctx,
			),
			executeShopifyQL(`FROM sessions SHOW sessions SINCE ${input.start_date} UNTIL ${input.end_date}`, ctx),
		]);

		const salesRow = salesResult.data[0] ?? {};
		const orders = (salesRow.orders as number) ?? 0;
		const totalSales = (salesRow.total_sales as number) ?? 0;
		const customers = (salesRow.customers as number) ?? 0;
		const sessions = (sessionsResult.data[0]?.sessions as number) ?? 0;

		const conversionRate = sessions > 0 ? Math.round((orders / sessions) * 10000) / 100 : 0;
		const averageOrderValue = orders > 0 ? Math.round((totalSales / orders) * 100) / 100 : 0;

		return {
			sessions,
			orders,
			customers,
			totalSales,
			conversionRate,
			averageOrderValue,
		};
	},
});
