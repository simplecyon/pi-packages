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
import { CompactDiffComponent } from "./diff.ts";
import { ActionGroupCoordinator } from "./grouping.ts";
import { formatErrorOutcome } from "./outcome.ts";
import { formatToolSummary } from "./summary.ts";
import { MinimalToolCallComponent, MinimalToolResultComponent, ThoughtLineComponent } from "./render.ts";
import { installCompactUserMessageRendering } from "./user-message.ts";
import { installThinkingSuppression } from "./thinking-suppression.ts";

interface MinimalRendererState {
	callInner?: ReturnType<NonNullable<ToolDefinition["renderCall"]>>;
	resultInner?: ReturnType<NonNullable<ToolDefinition["renderResult"]>>;
	minimalCall?: MinimalToolCallComponent;
	outcome?: string;
}

const SAFE_REDACT_REQUEST = "simplecyon:safe-operation:redact";
const BASH_REDACTION_OWNER_DISCOVER = "simplecyon:bash-redaction-owner:discover";
const BASH_REDACTION_OWNER_AVAILABLE = "simplecyon:bash-redaction-owner:available";
export const DEFAULT_BASH_TIMEOUT_SECONDS = 30;
const THOUGHT_ENTRY_TYPE = "simplecyon/pi-minimal-tui/thought";

function textResult(result: { content: Array<{ type: string; text?: string }> }): Text | undefined {
	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
	return output ? new Text(output, 0, 0) : undefined;
}

function editDiff(result: { details?: unknown }): string | undefined {
	if (!result.details || typeof result.details !== "object") return undefined;
	const diff = (result.details as Record<string, unknown>).diff;
	return typeof diff === "string" && diff.trim() ? diff : undefined;
}

function toolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
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
				showInnerCollapsed: false,
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
			const diff = base.name === "edit" && !context.isError ? editDiff(result) : undefined;
			const visibleInner =
				!options.expanded && diff ? new CompactDiffComponent(diff, theme, toolPath(context.args)) : inner;
			state.minimalCall?.update(
				formatToolSummary(base.name, context.args),
				state.callInner,
				context.expanded,
				theme,
				{
					getGroupView: () => grouping.getView(context.toolCallId),
					outcome: state.outcome,
					showInnerCollapsed: false,
				},
			);

			const visible = context.expanded || Boolean(diff);
			const preserveBackground = !context.expanded && Boolean(diff);
			const component =
				context.lastComponent instanceof MinimalToolResultComponent
					? context.lastComponent
					: new MinimalToolResultComponent(visibleInner, visible, preserveBackground);
			component.update(visibleInner, visible, preserveBackground);
			return component;
		},
	};
}

export function addDefaultBashTimeout(
	definition: ToolDefinition,
	defaultTimeoutSeconds = DEFAULT_BASH_TIMEOUT_SECONDS,
): ToolDefinition {
	if (definition.name !== "bash") return definition;
	const originalPrepare = definition.prepareArguments;
	return {
		...definition,
		prepareArguments(args) {
			const prepared = originalPrepare ? originalPrepare(args) : args;
			if (!prepared || typeof prepared !== "object") return prepared as any;
			const input = prepared as Record<string, unknown>;
			if (typeof input.timeout === "number") return prepared as any;
			return { ...input, timeout: defaultTimeoutSeconds } as any;
		},
	};
}

function addBashRedactionBridge(definition: ToolDefinition, pi: ExtensionAPI): ToolDefinition {
	if (definition.name !== "bash") return definition;
	const originalExecute = definition.execute;
	const sanitize = (value: unknown, phase: "stream" | "final"): unknown => {
		const request = { value, phase };
		pi.events.emit(SAFE_REDACT_REQUEST, request);
		return request.value;
	};
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, context) {
			const safeUpdate = onUpdate
				? (partial: unknown) => onUpdate(sanitize(partial, "stream") as any)
				: undefined;
			const result = await originalExecute(toolCallId, params, signal, safeUpdate, context);
			return sanitize(result, "final") as any;
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
	]
		.map((definition) => addDefaultBashTimeout(definition as ToolDefinition))
		.map((definition) => decorateTool(definition, grouping));
}

export default function minimalTuiExtension(pi: ExtensionAPI): void {
	installCompactUserMessageRendering();
	installThinkingSuppression();
	const cwd = process.cwd();
	const grouping = new ActionGroupCoordinator();
	pi.registerEntryRenderer(THOUGHT_ENTRY_TYPE, (entry, _options, theme) => {
		const elapsedMs = (entry.data as { elapsedMs?: number } | undefined)?.elapsedMs;
		if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return undefined;
		return new ThoughtLineComponent(elapsedMs, theme);
	});
	const announceBashRedactionOwner = () => {
		pi.events.emit(BASH_REDACTION_OWNER_AVAILABLE, {
			owner: "@simplecyon/pi-minimal-tui",
			protocolVersion: 1,
		});
	};
	pi.events.on(BASH_REDACTION_OWNER_DISCOVER, announceBashRedactionOwner);
	announceBashRedactionOwner();

	pi.on("session_start", (_event, context) => {
		grouping.rebuild(context.sessionManager.getBranch());
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user") grouping.addBoundary();
	});
	pi.on("agent_start", () => {
		grouping.startAgent();
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
		grouping.finishAgent();
		const turn = grouping.getLastTurn();
		if (turn && !turn.hadTool && turn.elapsedMs !== undefined) {
			pi.appendEntry(THOUGHT_ENTRY_TYPE, { elapsedMs: turn.elapsedMs });
		}
	});

	for (const definition of createMinimalToolDefinitions(cwd, grouping)) {
		pi.registerTool(addBashRedactionBridge(definition, pi));
	}
}
