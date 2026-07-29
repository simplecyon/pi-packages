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
import { ActionGroupCoordinator } from "./grouping.ts";
import { formatErrorOutcome } from "./outcome.ts";
import { formatToolSummary } from "./summary.ts";
import { MinimalToolCallComponent, MinimalToolResultComponent } from "./render.ts";

interface MinimalRendererState {
	callInner?: ReturnType<NonNullable<ToolDefinition["renderCall"]>>;
	resultInner?: ReturnType<NonNullable<ToolDefinition["renderResult"]>>;
	minimalCall?: MinimalToolCallComponent;
	outcome?: string;
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): Text | undefined {
	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
	return output ? new Text(output, 0, 0) : undefined;
}

function decorateTool(base: ToolDefinition, grouping: ActionGroupCoordinator): ToolDefinition {
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
			grouping.registerRenderer(context.toolCallId, context.invalidate);
			const options = {
				getGroupView: () => grouping.getView(context.toolCallId),
				outcome: state.outcome,
				showInnerCollapsed: base.name === "edit" && !context.isError,
			};

			const component =
				context.lastComponent instanceof MinimalToolCallComponent
					? context.lastComponent
					: new MinimalToolCallComponent(formatToolSummary(base.name, args), inner, context.expanded, theme, options);
			component.update(formatToolSummary(base.name, args), inner, context.expanded, theme, options);
			state.minimalCall = component;
			return component;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as MinimalRendererState;
			const inner = originalRenderResult
				? originalRenderResult(result, options, theme, { ...context, lastComponent: state.resultInner })
				: textResult(result);
			state.resultInner = inner;
			state.outcome = !options.isPartial && context.isError ? formatErrorOutcome(result) : undefined;
			grouping.markError(context.toolCallId, !options.isPartial && context.isError);
			state.minimalCall?.update(
				formatToolSummary(base.name, context.args),
				state.callInner,
				context.expanded,
				theme,
				{
					getGroupView: () => grouping.getView(context.toolCallId),
					outcome: state.outcome,
					showInnerCollapsed: base.name === "edit" && !context.isError,
				},
			);

			const visible = context.expanded || (base.name === "edit" && !context.isError);
			const component =
				context.lastComponent instanceof MinimalToolResultComponent
					? context.lastComponent
					: new MinimalToolResultComponent(inner, visible);
			component.update(inner, visible);
			return component;
		},
	};
}

export function createMinimalToolDefinitions(
	cwd: string,
	grouping = new ActionGroupCoordinator(),
): ToolDefinition[] {
	return [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	].map((definition) => decorateTool(definition as ToolDefinition, grouping));
}

export default function minimalTuiExtension(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const grouping = new ActionGroupCoordinator();

	pi.on("session_start", (_event, context) => {
		grouping.rebuild(context.sessionManager.getBranch());
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user") grouping.addBoundary();
	});
	pi.on("message_end", (event) => {
		grouping.recordMessage(event.message);
	});
	pi.on("tool_execution_start", (event) => {
		grouping.recordTool(event.toolCallId, event.toolName);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.isError) grouping.markError(event.toolCallId);
	});
	pi.on("agent_end", () => {
		grouping.addBoundary();
	});

	for (const definition of createMinimalToolDefinitions(cwd, grouping)) {
		pi.registerTool(definition);
	}
}
