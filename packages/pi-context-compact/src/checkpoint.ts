import {
	CHECKPOINT_OWNER,
	CHECKPOINT_SCHEMA_VERSION,
	MAX_CHECKPOINT_CHARS,
	type StoredMessage,
} from "./types.ts";

const CONSTRAINT_PATTERN =
	/(必须|不要|不能|只(?:能|要)?|需要|应该|保持|默认|除非|must\b|do not\b|don't\b|should\b|only\b|never\b|required\b)/iu;

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function compactText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function previousTag(previousSummary: string | undefined, tag: string): string {
	if (!previousSummary?.includes(`<${tag}>`)) return "";
	const match = previousSummary.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
	return match ? match[1].replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "";
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = value.toLocaleLowerCase();
		if (!value || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function constraintCandidates(messages: StoredMessage[]): string[] {
	const candidates: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		for (const line of message.text.split(/[\n。！？!?]+/u)) {
			const candidate = compactText(line, 240);
			if (CONSTRAINT_PATTERN.test(candidate)) candidates.push(candidate);
		}
	}
	return unique(candidates).slice(-6);
}

function activeFiles(messages: StoredMessage[]): string[] {
	const files: string[] = [];
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			for (const key of ["path", "file_path", "filePath"]) {
				const value = call.arguments[key];
				if (typeof value === "string" && value.trim()) files.push(value.trim());
			}
		}
	}
	return unique(files).slice(-10);
}

function errors(messages: StoredMessage[]): string[] {
	return unique(
		messages
			// Tool output frequently contains words such as "error", "failed",
			// or "exception" in documentation and source code. Only trust the
			// provider/runtime error bit; lexical matching creates false
			// blockers in the continuation checkpoint.
			.filter((message) => message.isError === true)
			.map((message) => compactText(message.text, 360)),
	).slice(-3);
}

interface Section {
	tag: string;
	value: string;
}

function section(tag: string, value: string): string {
	return `  <${tag}>${escapeXml(value)}</${tag}>`;
}

export function buildCheckpoint(
	messages: StoredMessage[],
	segmentId: string,
	previousSummary?: string,
): string {
	const userMessages = messages.filter((message) => message.role === "user" && message.text);
	const assistantMessages = messages.filter((message) => message.role === "assistant" && message.text);
	const goal =
		compactText(userMessages.at(-1)?.text ?? "", 1200) ||
		compactText(previousTag(previousSummary, "goal"), 1200) ||
		"Continue the retained recent work.";

	const previousConstraints = previousTag(previousSummary, "constraints")
		.split(/\s*[•\n]\s*/u)
		.map((value) => compactText(value, 240))
		.filter(Boolean);
	const constraints = unique([...previousConstraints, ...constraintCandidates(messages)]).slice(-6);
	const fileList = activeFiles(messages);
	const errorList = errors(messages);
	const workingState = compactText(assistantMessages.at(-1)?.text ?? "", 900);
	const recentUserContext = userMessages
		.slice(-3, -1)
		.map((message) => compactText(message.text, 500))
		.filter(Boolean);
	const legacy =
		previousSummary && !previousSummary.includes("<continuation_checkpoint")
			? compactText(previousSummary, 1200)
			: "";

	const required = [
		`<continuation_checkpoint owner="${CHECKPOINT_OWNER}" schema_version="${CHECKPOINT_SCHEMA_VERSION}">`,
		section("goal", goal),
	];
	const optional: Section[] = [
		{ tag: "constraints", value: constraints.map((value) => `• ${value}`).join("\n") },
		{ tag: "recent_user_context", value: recentUserContext.map((value) => `• ${value}`).join("\n") },
		{ tag: "unresolved_errors", value: errorList.map((value) => `• ${value}`).join("\n") },
		{ tag: "active_files", value: fileList.map((value) => `• ${value}`).join("\n") },
		{ tag: "working_state", value: workingState },
		{ tag: "legacy_context", value: legacy },
	];
	const retrieval = section(
		"history",
		`Older details were stored in segment ${segmentId}. Use compact_search before asking the user to repeat them.`,
	);
	const footer = "</continuation_checkpoint>";

	const lines = [...required];
	for (const candidate of optional) {
		if (!candidate.value) continue;
		const rendered = section(candidate.tag, candidate.value);
		const projected = [...lines, rendered, retrieval, footer].join("\n");
		if (projected.length <= MAX_CHECKPOINT_CHARS) lines.push(rendered);
	}
	lines.push(retrieval, footer);

	const summary = lines.join("\n");
	if (summary.length > MAX_CHECKPOINT_CHARS) {
		throw new Error(`checkpoint exceeds ${MAX_CHECKPOINT_CHARS} characters`);
	}
	return summary;
}
