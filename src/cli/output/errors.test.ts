import { describe, expect, it } from "vitest";
import { formatCostSummary, formatError } from "./errors.js";

describe("formatCostSummary", () => {
	it("formats cost summary with all fields", () => {
		const result = formatCostSummary({
			totalCostConsumed: 28,
			budgetRemaining: 972,
			totalCallsMade: 3,
		});
		expect(result).toBe("Cost: 28 points | Budget: 972/1000 | Session: 3 calls, 28 points total");
	});

	it("handles zero cost", () => {
		const result = formatCostSummary({
			totalCostConsumed: 0,
			budgetRemaining: 1000,
			totalCallsMade: 0,
		});
		expect(result).toBe("Cost: 0 points | Budget: 1000/1000 | Session: 0 calls, 0 points total");
	});

	it("calculates total budget from remaining + consumed", () => {
		const result = formatCostSummary({
			totalCostConsumed: 500,
			budgetRemaining: 500,
			totalCallsMade: 10,
		});
		expect(result).toContain("Budget: 500/1000");
	});
});

describe("formatError", () => {
	it("formats error as JSON with code and message", () => {
		const result = formatError("Product not found", "NOT_FOUND");
		const parsed = JSON.parse(result);
		expect(parsed).toEqual({
			error: {
				code: "NOT_FOUND",
				message: "Product not found",
			},
		});
	});

	it("returns valid JSON string", () => {
		const result = formatError("test error", "TEST");
		expect(() => JSON.parse(result)).not.toThrow();
	});
});
