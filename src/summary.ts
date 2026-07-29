import { basename, dirname, normalize, sep } from "node:path";

export interface ToolSummary {
	verb: string;
	detail?: string;
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

function oneLine(value: string, maxLength = 96): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function displayPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalize(value);
	const home = process.env.HOME;
	if (home && normalized.startsWith(`${home}${sep}`)) {
		return `~${sep}${normalized.slice(home.length + 1)}`;
	}
	return value;
}

function readSummary(args: unknown): ToolSummary {
	const path = stringArg(args, "path", "file_path");
	if (!path) return { verb: "read" };

	const fileName = basename(path);
	if (fileName.toLowerCase() === "skill.md") {
		return { verb: "read", detail: `skill: ${basename(dirname(path)) || fileName}` };
	}

	const posixPath = path.replace(/\\/g, "/");
	if (
		posixPath.includes("/@earendil-works/pi-coding-agent/docs/") ||
		posixPath.includes("/@earendil-works/pi-coding-agent/examples/")
	) {
		return { verb: "read", detail: `docs: ${fileName}` };
	}

	return { verb: "read", detail: displayPath(path) };
}

export function formatToolSummary(toolName: string, args: unknown): ToolSummary {
	switch (toolName) {
		case "read":
			return readSummary(args);
		case "bash": {
			const command = stringArg(args, "command");
			return { verb: "bash", detail: command ? oneLine(command) : undefined };
		}
		case "edit":
			return { verb: "edit", detail: displayPath(stringArg(args, "path", "file_path")) };
		case "write":
			return { verb: "write", detail: displayPath(stringArg(args, "path", "file_path")) };
		case "grep": {
			const pattern = stringArg(args, "pattern", "query");
			const path = displayPath(stringArg(args, "path"));
			const query = pattern ? `"${oneLine(pattern, 56)}"` : undefined;
			return { verb: "grep", detail: [query, path ? `in ${path}` : undefined].filter(Boolean).join(" ") || undefined };
		}
		case "find": {
			const pattern = stringArg(args, "pattern", "query");
			const path = displayPath(stringArg(args, "path"));
			const query = pattern ? `"${oneLine(pattern, 56)}"` : undefined;
			return { verb: "find", detail: [query, path ? `in ${path}` : undefined].filter(Boolean).join(" ") || undefined };
		}
		case "ls":
			return { verb: "ls", detail: displayPath(stringArg(args, "path")) };
		default:
			return { verb: toolName };
	}
}
