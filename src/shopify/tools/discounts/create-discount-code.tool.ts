import type { ExecutionContext } from "@core/engine/types.js";
import { defineTool } from "@core/helpers/define-tool.js";
import { z } from "zod";
import mutation from "./create-discount-code.graphql";

interface CreateDiscountCodeInput {
	code: string;
	title: string;
	amount: number;
	value_type?: "fixed_amount" | "percentage";
	usage_limit?: number;
	applies_once_per_customer?: boolean;
	starts_at?: string;
	ends_at?: string;
	minimum_subtotal?: number;
	combines_with_order_discounts?: boolean;
	combines_with_product_discounts?: boolean;
	combines_with_shipping_discounts?: boolean;
}

export const createDiscountCode = defineTool({
	name: "create_discount_code",
	domain: "discounts",
	tier: 1,
	description:
		"Create a basic discount code that customers redeem at checkout. Supports fixed-amount (e.g. 7 € off) or percentage discounts, an optional total usage limit, an expiry date, and a minimum order subtotal. Use for gift/voucher codes, tombola prizes or sponsorship perks. Codes are not combinable with other discounts by default.",
	scopes: ["write_discounts"],
	input: {
		code: z.string().describe("The code customers type at checkout, e.g. COURT7-P8HAF"),
		title: z.string().describe("Internal title shown in the Shopify admin discount list"),
		amount: z
			.number()
			.describe(
				"Discount value. fixed_amount → amount off in shop currency (e.g. 7). percentage → percent off (e.g. 10 = 10%).",
			),
		value_type: z.enum(["fixed_amount", "percentage"]).optional().describe("Default: fixed_amount"),
		usage_limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Max total redemptions across all customers. Omit for unlimited."),
		applies_once_per_customer: z.boolean().optional().describe("Default: true"),
		starts_at: z.string().optional().describe("ISO 8601 start datetime. Default: now."),
		ends_at: z.string().optional().describe("ISO 8601 expiry datetime. Omit for no expiry."),
		minimum_subtotal: z
			.number()
			.optional()
			.describe("Minimum order subtotal (shop currency) required to redeem. Omit for no minimum."),
		combines_with_order_discounts: z.boolean().optional().describe("Default: false"),
		combines_with_product_discounts: z.boolean().optional().describe("Default: false"),
		combines_with_shipping_discounts: z.boolean().optional().describe("Default: false"),
	},
	handler: async (input: CreateDiscountCodeInput, ctx: ExecutionContext) => {
		const valueType = input.value_type ?? "fixed_amount";
		const value =
			valueType === "percentage"
				? { percentage: input.amount / 100 }
				: { discountAmount: { amount: input.amount, appliesOnEachItem: false } };

		const basicCodeDiscount: Record<string, unknown> = {
			title: input.title,
			code: input.code,
			startsAt: input.starts_at ?? new Date().toISOString(),
			customerSelection: { all: true },
			customerGets: { value, items: { all: true } },
			appliesOncePerCustomer: input.applies_once_per_customer ?? true,
			combinesWith: {
				orderDiscounts: input.combines_with_order_discounts ?? false,
				productDiscounts: input.combines_with_product_discounts ?? false,
				shippingDiscounts: input.combines_with_shipping_discounts ?? false,
			},
		};
		if (input.ends_at !== undefined) basicCodeDiscount.endsAt = input.ends_at;
		if (input.usage_limit !== undefined) basicCodeDiscount.usageLimit = input.usage_limit;
		if (input.minimum_subtotal !== undefined) {
			basicCodeDiscount.minimumRequirement = {
				subtotal: { greaterThanOrEqualToSubtotal: String(input.minimum_subtotal) },
			};
		}

		const result = await ctx.shopify.query(mutation, { basicCodeDiscount }, "mutation");
		const data = result.data ?? result;
		const payload = data.discountCodeBasicCreate;

		if (payload.userErrors?.length > 0) {
			return { error: true, userErrors: payload.userErrors };
		}

		const node = payload.codeDiscountNode;
		const cd = node?.codeDiscount ?? {};
		return {
			id: node?.id,
			code: cd.codes?.nodes?.[0]?.code ?? input.code,
			title: cd.title ?? input.title,
			status: cd.status,
			startsAt: cd.startsAt,
			endsAt: cd.endsAt ?? null,
		};
	},
});
