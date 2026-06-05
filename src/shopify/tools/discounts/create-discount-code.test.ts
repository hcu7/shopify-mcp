import type { ExecutionContext } from "@core/engine/types.js";
import { CostTracker } from "@core/observability/cost-tracker.js";
import { describe, expect, it, vi } from "vitest";
import { createDiscountCode } from "./create-discount-code.tool.js";

function makeCtx(queryFn: any): ExecutionContext {
	return {
		shopify: { query: queryFn },
		config: {} as any,
		storage: {} as any,
		logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any,
		costTracker: new CostTracker(),
	};
}

const okResponse = {
	discountCodeBasicCreate: {
		codeDiscountNode: {
			id: "gid://shopify/DiscountCodeNode/1",
			codeDiscount: {
				title: "Tombola 7€",
				status: "ACTIVE",
				startsAt: "2026-06-05T00:00:00Z",
				endsAt: "2027-07-18T23:59:59Z",
				codes: { nodes: [{ code: "COURT7-P8HAF" }] },
			},
		},
		userErrors: [],
	},
};

describe("create_discount_code", () => {
	it("has correct definition metadata", () => {
		expect(createDiscountCode.name).toBe("create_discount_code");
		expect(createDiscountCode.domain).toBe("discounts");
		expect(createDiscountCode.tier).toBe(1);
		expect(createDiscountCode.scopes).toEqual(["write_discounts"]);
		expect(createDiscountCode.input).toHaveProperty("code");
		expect(createDiscountCode.input).toHaveProperty("amount");
	});

	it("builds a fixed-amount DiscountCodeBasicInput with safe defaults", async () => {
		const queryFn = vi.fn().mockResolvedValue(okResponse);
		const result = await createDiscountCode.handler?.(
			{ code: "COURT7-P8HAF", title: "Tombola 7€", amount: 7, usage_limit: 1, ends_at: "2027-07-18T23:59:59Z" },
			makeCtx(queryFn),
		);

		const call = queryFn.mock.calls[0];
		expect(call[2]).toBe("mutation"); // queryType → skips cache
		const b = call[1].basicCodeDiscount;
		expect(b.code).toBe("COURT7-P8HAF");
		expect(b.customerGets.value).toEqual({ discountAmount: { amount: 7, appliesOnEachItem: false } });
		expect(b.customerGets.items).toEqual({ all: true });
		expect(b.customerSelection).toEqual({ all: true });
		expect(b.appliesOncePerCustomer).toBe(true);
		expect(b.usageLimit).toBe(1);
		expect(b.endsAt).toBe("2027-07-18T23:59:59Z");
		expect(b.startsAt).toEqual(expect.any(String));
		expect(b.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: false });
		expect(b.minimumRequirement).toBeUndefined();
		expect(result.code).toBe("COURT7-P8HAF");
		expect(result.status).toBe("ACTIVE");
	});

	it("supports percentage value and minimum subtotal", async () => {
		const queryFn = vi.fn().mockResolvedValue(okResponse);
		await createDiscountCode.handler?.(
			{ code: "X20", title: "Fürstenzell 20%", amount: 20, value_type: "percentage", minimum_subtotal: 50 },
			makeCtx(queryFn),
		);
		const b = queryFn.mock.calls[0][1].basicCodeDiscount;
		expect(b.customerGets.value).toEqual({ percentage: 0.2 });
		expect(b.minimumRequirement).toEqual({ subtotal: { greaterThanOrEqualToSubtotal: "50" } });
	});

	it("returns userErrors on failure", async () => {
		const queryFn = vi.fn().mockResolvedValue({
			discountCodeBasicCreate: {
				codeDiscountNode: null,
				userErrors: [{ field: ["code"], code: "TAKEN", message: "Code already exists" }],
			},
		});
		const result = await createDiscountCode.handler?.({ code: "DUP", title: "t", amount: 5 }, makeCtx(queryFn));
		expect(result.error).toBe(true);
		expect(result.userErrors[0].message).toContain("already exists");
	});
});
