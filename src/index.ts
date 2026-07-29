import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolSummary } from "./summary.ts";
import { MinimalToolCallComponent, MinimalToolResultComponent } from "./render.ts";

interface MinimalRendererState {
	callInner?: ReturnType<NonNullable<ToolDefinition["renderCall"]>>;
	resultInner?: ReturnType<NonNullable<ToolDefinition["renderResult"]>>;
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): Text | undefined {
	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
	return output ? new Text(output, 0, 0) : undefined;
}

function decorateTool(base: ToolDefinition): ToolDefinition {
	const originalRenderCall = base.renderCall;
	const originalRenderResult = base.renderResult;

	return {
		...base,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as MinimalRendererState;
			const inner = originalRenderCall
				? originalRenderCall(args, theme, { ...context, lastComponent: state.callInner })
				: undefined;
			state.callInner = inner;

			const component =
				context.lastComponent instanceof MinimalToolCallComponent
					? context.lastComponent
					: new MinimalToolCallComponent(formatToolSummary(base.name, args), inner, context.expanded, theme);
			component.update(formatToolSummary(base.name, args), inner, context.expanded, theme);
			return component;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as MinimalRendererState;
			const inner = originalRenderResult
				? originalRenderResult(result, options, theme, { ...context, lastComponent: state.resultInner })
				: textResult(result);
			state.resultInner = inner;

			const visible = context.expanded || context.isError;
			const component =
				context.lastComponent instanceof MinimalToolResultComponent
					? context.lastComponent
					: new MinimalToolResultComponent(inner, visible);
			component.update(inner, visible);
			return component;
		},
	};
}

export function createMinimalToolDefinitions(cwd: string): ToolDefinition[] {
	return [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	].map((definition) => decorateTool(definition as ToolDefinition));
}

export default function minimalTuiExtension(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	for (const definition of createMinimalToolDefinitions(cwd)) {
		pi.registerTool(definition);
	}
}
