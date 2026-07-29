import type { StoredMessage, StoredToolCall } from "./types.ts";

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return stringify(content);

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item.type === "thinking" && typeof item.thinking === "string") {
			parts.push(`[thinking]\n${item.thinking}`);
		} else if (item.type === "image") {
			parts.push("[image omitted from compact history]");
		}
	}
	return parts.join("\n");
}

function toolCallsFromContent(content: unknown): StoredToolCall[] {
	if (!Array.isArray(content)) return [];
	const calls: StoredToolCall[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		if (item.type !== "toolCall" || typeof item.name !== "string") continue;
		const args =
			item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
				? (item.arguments as Record<string, unknown>)
				: {};
		calls.push({ name: item.name, arguments: args });
	}
	return calls;
}

export function serializeMessages(messages: unknown[]): StoredMessage[] {
	return messages.map((message, ordinal) => {
		const item =
			message && typeof message === "object"
				? (message as Record<string, unknown>)
				: ({ content: message } as Record<string, unknown>);
		const role = typeof item.role === "string" ? item.role : "unknown";
		const calls = toolCallsFromContent(item.content);
		const parts: string[] = [];

		const content = contentText(item.content);
		if (content) parts.push(content);

		if (role === "assistant") {
			for (const call of calls) {
				parts.push(`[tool call: ${call.name}]\n${stringify(call.arguments)}`);
			}
		} else if (role === "bashExecution") {
			if (typeof item.command === "string") parts.push(`$ ${item.command}`);
			if (typeof item.output === "string") parts.push(item.output);
		} else if (role === "compactionSummary" || role === "branchSummary") {
			if (typeof item.summary === "string") parts.push(item.summary);
		}

		return {
			ordinal,
			role,
			text: parts.join("\n").trim(),
			...(calls.length > 0 ? { toolCalls: calls } : {}),
			...(item.isError === true || item.stopReason === "error" ? { isError: true } : {}),
		};
	});
}
