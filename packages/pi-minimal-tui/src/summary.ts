export interface ToolSummary {
	verb: string;
	detail?: string;
	bullet?: boolean;
}

function stringArg(args: unknown, ...keys: string[]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function oneLine(value: string, maxLength = 72): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function leafName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.split("/").at(-1) || value;
}

export function formatToolSummary(toolName: string, args: unknown): ToolSummary {
	switch (toolName) {
		case "read":
			return { verb: "Read", detail: leafName(stringArg(args, "path", "file_path")) };
		case "bash": {
			const command = stringArg(args, "command");
			return { verb: "Bash", detail: command ? oneLine(command) : undefined };
		}
		case "edit":
			return { verb: "Edit", detail: leafName(stringArg(args, "path", "file_path")) };
		case "write":
			return { verb: "Write", detail: leafName(stringArg(args, "path", "file_path")) };
		case "grep": {
			const pattern = stringArg(args, "pattern", "query");
			return { verb: "Grep", detail: pattern ? oneLine(pattern, 56) : undefined };
		}
		case "find": {
			const pattern = stringArg(args, "pattern", "query");
			return { verb: "Find", detail: pattern ? oneLine(pattern, 56) : undefined };
		}
		case "ls":
			return { verb: "List", detail: leafName(stringArg(args, "path")) };
		default:
			return { verb: toolName };
	}
}
