/**
 * Core converter: transforms a ToolDefinition into a Commander CLI command.
 *
 * This is the glue between the tool engine and the CLI surface.
 * Each tool becomes a fully functional CLI command with proper arg parsing,
 * type coercion, output formatting, and error handling.
 */

import { Command, Option } from "commander";
import type { ZodType } from "zod";
import type { ToolDefinition } from "../../core/engine/types.js";
import { formatCostSummary, formatError } from "../output/errors.js";
import { formatOutput } from "../output/formatter.js";
import { confirmMutation, isMutation } from "../safety/mutation-guard.js";
import { zodToJsonSchema } from "./zod-to-citty.js";

/**
 * Walk up the Commander parent chain, merging opts() from root → leaf
 * so that global flags defined on the root program are accessible
 * from any leaf action.
 */
function collectOptions(cmd: Command): Record<string, unknown> {
	const chain: Command[] = [];
	let current: Command | null = cmd;
	while (current) {
		chain.unshift(current);
		current = current.parent ?? null;
	}
	return Object.assign({}, ...chain.map((c) => c.opts()));
}

/**
 * Add Commander options derived from a tool's Zod input schema.
 *
 * Introspects Zod _def to detect type and constraints:
 * - z.string()  → --name <value>
 * - z.number()  → --limit <n> (with parseFloat parser)
 * - z.boolean() → --flag (boolean flag)
 * - z.enum()    → --status <value> with .choices([...])
 * - Optional    → not required
 * - Default     → set default value
 */
function addZodOptions(cmd: Command, input: Record<string, ZodType>): void {
	for (const [key, schema] of Object.entries(input)) {
		addSingleOption(cmd, key, schema);
	}
}

function addSingleOption(cmd: Command, key: string, schema: ZodType): void {
	// biome-ignore lint/suspicious/noExplicitAny: Zod internals require _def access
	const def = (schema as any)._def;
	const typeName: string = def.typeName;

	// Unwrap wrappers
	if (typeName === "ZodOptional") {
		addSingleOption(cmd, key, def.innerType);
		// Mark the last-added option as optional (no .makeOptionMandatory)
		return;
	}

	if (typeName === "ZodDefault") {
		addSingleOption(cmd, key, def.innerType);
		// Set default on the last-added option
		const lastOpt = cmd.options[cmd.options.length - 1];
		if (lastOpt) {
			lastOpt.defaultValue = def.defaultValue();
		}
		return;
	}

	const flag = key.length === 1 ? `-${key}` : `--${key}`;
	const description: string = def.description ?? "";

	if (typeName === "ZodBoolean") {
		cmd.option(`${flag}`, description);
		return;
	}

	if (typeName === "ZodNumber") {
		const parts: string[] = [];
		if (description) parts.push(description);
		if (def.checks) {
			for (const check of def.checks) {
				if (check.kind === "min") parts.push(`min: ${check.value}`);
				if (check.kind === "max") parts.push(`max: ${check.value}`);
			}
		}
		const desc = parts.length > 0 ? parts.join(", ") : "";
		cmd.option(`${flag} <n>`, desc, Number.parseFloat);
		return;
	}

	if (typeName === "ZodEnum") {
		const values: string[] = def.values;
		const desc = description || `One of: ${values.join(", ")}`;
		const opt = new Option(`${flag} <value>`, desc).choices(values);
		cmd.addOption(opt);
		return;
	}

	// ZodString and fallback
	cmd.option(`${flag} <value>`, description);
}

/**
 * Coerce a string value from CLI into the proper type expected by the Zod schema.
 *
 * Commander handles some coercion (parseFloat for numbers), but Zod expects
 * exact types. This ensures full compatibility.
 */
export function coerceValue(value: unknown, schema: ZodType): unknown {
	if (value === undefined || value === null) {
		return value;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Zod internals require _def access
	const def = (schema as any)._def;
	const typeName: string = def.typeName;

	if (typeName === "ZodOptional" || typeName === "ZodDefault") {
		return coerceValue(value, def.innerType);
	}

	if (typeName === "ZodNumber") {
		return Number(value);
	}

	if (typeName === "ZodBoolean") {
		if (typeof value === "boolean") return value;
		return value === "true";
	}

	// ZodString, ZodEnum, and fallback — pass through
	return value;
}

/**
 * Coerce all input values from CLI types to the types expected by the tool's Zod schema.
 */
export function coerceInput(
	raw: Record<string, unknown>,
	inputSchema: Record<string, ZodType>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		const schema = inputSchema[key];
		if (!schema) {
			result[key] = value;
			continue;
		}
		result[key] = coerceValue(value, schema);
	}

	return result;
}

/**
 * Converts a ToolDefinition into a Commander Command.
 *
 * @param tool - The tool definition to convert
 * @param actionName - The derived CLI action name (e.g. "list" from "list_products")
 */
export function toolToCommand(tool: ToolDefinition, actionName: string): Command {
	const cmd = new Command(actionName).description(tool.description);

	addZodOptions(cmd, tool.input);

	cmd.action(async (...actionArgs: unknown[]) => {
		try {
			const command = actionArgs[actionArgs.length - 1] as Command;
			const allOpts = collectOptions(command);

			// --schema: show command schema, don't execute
			if (allOpts.schema) {
				const schemaData: Record<string, unknown> = {
					name: tool.name,
					domain: tool.domain,
					tier: tool.tier,
					description: tool.description,
					scopes: tool.scopes,
					input: zodToJsonSchema(tool.input),
				};
				if (tool.outputFields && tool.outputFields.length > 0) {
					schemaData.outputFields = tool.outputFields;
				}
				process.stdout.write(`${JSON.stringify(schemaData, null, 2)}\n`);
				return;
			}

			// Extract tool-specific options (exclude global flags)
			const toolInput: Record<string, unknown> = {};
			for (const key of Object.keys(tool.input)) {
				if (allOpts[key] !== undefined) {
					toolInput[key] = allOpts[key];
				}
			}

			// Coerce types from CLI strings to proper types
			const coercedInput = coerceInput(toolInput, tool.input);

			// --dry-run (Commander converts to dryRun camelCase)
			if (allOpts.dryRun) {
				const output = JSON.stringify(
					{
						dryRun: true,
						tool: tool.name,
						domain: tool.domain,
						mutation: isMutation(tool),
						scopes: tool.scopes,
						input: coercedInput,
					},
					null,
					2,
				);
				process.stdout.write(`${output}\n`);
				return;
			}

			// Confirm mutations before executing (unless --yes or non-TTY)
			if (isMutation(tool)) {
				const confirmed = await confirmMutation(tool, { yes: allOpts.yes as boolean | undefined });
				if (!confirmed) {
					process.stderr.write("Aborted.\n");
					return;
				}
			}

			// Boot execution context (lazy — only when actually executing)
			const { createExecutionContext } = await import("./execution-context.js");
			const { ctx, engine } = await createExecutionContext();

			// Execute the tool
			const result = await engine.execute(tool.name, coercedInput, ctx);

			// Format output (respecting --json, --fields, --jq flags)
			const output = formatOutput(result.data, {
				json: allOpts.json as boolean | undefined,
				fields: allOpts.fields as string | undefined,
				jq: allOpts.jq as string | undefined,
			});
			process.stdout.write(`${output}\n`);

			// Write cost summary to stderr
			const stats = ctx.costTracker.getSessionStats();
			if (stats.totalCallsMade > 0) {
				process.stderr.write(`${formatCostSummary(stats)}\n`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`${formatError(message, "EXECUTION_ERROR")}\n`);
			process.exitCode = 1;
		}
	});

	return cmd;
}
