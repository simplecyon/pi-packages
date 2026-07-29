import {
	estimateTextTokens,
	TOKEN_ROI_ARTIFACT_EVENT,
} from "@simplecyon/pi-context-core";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildArtifactPreview,
	decideArtifact,
	loadPolicy,
} from "./policy.ts";
import {
	listArtifacts,
	hashTextBlocks,
	readArtifact,
	writeArtifact,
} from "./storage.ts";
import type {
	ArtifactSummary,
	TextBlock,
} from "./types.ts";

const SAFE_CAPABILITY_DISCOVER = "simplecyon:safe-operation:discover";
const SAFE_CAPABILITY_AVAILABLE = "simplecyon:safe-operation:available";
const SAFE_REDACT_REQUEST = "simplecyon:safe-operation:redact";
const RETRIEVAL_TOOL = "artifact_read";
const MAX_BASH_SOURCE_BYTES = 32 * 1024 * 1024;
const PI_BASH_TEMP_FILE = /^pi-bash-[a-f0-9]{16}\.log$/;

interface ArtifactReadDetails {
	found: boolean;
	id?: string;
	offset?: number;
	nextOffset?: number | null;
	totalCharacters?: number;
	sha256?: string;
	matchOffsets?: number[];
}

const ArtifactReadSchema = Type.Object({
	id: Type.String({ pattern: "^art_[a-f0-9-]{36}$" }),
	query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 256, maximum: 12_000, default: 12_000 })),
}, { additionalProperties: false });

function sessionRef(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	return ctx.sessionManager.getSessionFile() ??
		`${ctx.cwd}:${ctx.sessionManager.getSessionId()}`;
}

function isSafeCapability(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const capability = value as {
		owner?: unknown;
		protocolVersion?: unknown;
		redactsToolResults?: unknown;
	};
	return (
		capability.owner === "@simplecyon/pi-safe-operation" &&
		capability.protocolVersion === 1 &&
		capability.redactsToolResults === true
	);
}

interface BashTruncationDetails {
	fullOutputPath?: unknown;
	truncation?: {
		truncated?: unknown;
		totalBytes?: unknown;
	};
}

function bashFullOutputCandidate(details: unknown): {
	path: string;
	estimatedTokens: number;
} | null {
	if (!details || typeof details !== "object") return null;
	const value = details as BashTruncationDetails;
	if (value.truncation?.truncated !== true) return null;
	if (
		typeof value.fullOutputPath !== "string" ||
		typeof value.truncation.totalBytes !== "number" ||
		!Number.isFinite(value.truncation.totalBytes) ||
		value.truncation.totalBytes <= 0
	) {
		return null;
	}
	const sourcePath = resolve(value.fullOutputPath);
	const tempRoot = resolve(tmpdir());
	if (
		dirname(sourcePath) !== tempRoot ||
		!PI_BASH_TEMP_FILE.test(basename(sourcePath))
	) {
		return null;
	}
	return {
		path: sourcePath,
		estimatedTokens: Math.ceil(value.truncation.totalBytes / 4),
	};
}

async function recoverSafeBashOutput(
	pi: ExtensionAPI,
	candidate: { path: string; estimatedTokens: number },
): Promise<TextBlock[] | null> {
	const source = await lstat(candidate.path);
	if (!source.isFile() || source.isSymbolicLink()) return null;
	if (source.size <= 0 || source.size > MAX_BASH_SOURCE_BYTES) return null;
	const raw = await readFile(candidate.path, "utf8");
	const request = {
		value: {
			content: [{ type: "text" as const, text: raw }],
		},
		phase: "final" as const,
	};
	pi.events.emit(SAFE_REDACT_REQUEST, request);
	if (!request.value || typeof request.value !== "object") return null;
	const content = (request.value as { content?: unknown }).content;
	if (
		!Array.isArray(content) ||
		content.length !== 1 ||
		!content[0] ||
		typeof content[0] !== "object" ||
		(content[0] as { type?: unknown }).type !== "text" ||
		typeof (content[0] as { text?: unknown }).text !== "string"
	) {
		return null;
	}
	return [{
		type: "text",
		text: (content[0] as { text: string }).text,
	}];
}

export default function contextArtifactsExtension(pi: ExtensionAPI): void {
	const policy = loadPolicy();
	let safetyReady = false;
	let currentSessionRef = "";
	let artifacts = new Map<string, ArtifactSummary>();
	let artifactsByHash = new Map<string, ArtifactSummary>();
	let archivedResults = 0;
	let tokensSaved = 0;
	let archiveFailures = 0;
	let reusedArtifacts = 0;
	let recoveredBashResults = 0;

	function setRetrievalActive(active: boolean): void {
		const current = pi.getActiveTools();
		const next = active
			? [...new Set([...current, RETRIEVAL_TOOL])]
			: current.filter((name) => name !== RETRIEVAL_TOOL);
		if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
			pi.setActiveTools(next);
		}
	}

	pi.events.on(SAFE_CAPABILITY_AVAILABLE, (data) => {
		if (isSafeCapability(data)) safetyReady = true;
	});
	pi.events.emit(SAFE_CAPABILITY_DISCOVER, {
		owner: "@simplecyon/pi-context-artifacts",
		protocolVersion: 1,
	});

	pi.registerTool<typeof ArtifactReadSchema, ArtifactReadDetails>({
		name: RETRIEVAL_TOOL,
		label: "Read Context Artifact",
		description:
			"Read an exact bounded chunk or search within a large tool result previously archived outside model context.",
		parameters: ArtifactReadSchema,
		async execute(_toolCallId, params) {
			if (!currentSessionRef || !artifacts.has(params.id)) {
				return {
					content: [{ type: "text" as const, text: `Artifact not found in this session: ${params.id}` }],
					details: { found: false },
				};
			}
			const record = await readArtifact(currentSessionRef, params.id);
			if (!record) {
				return {
					content: [{ type: "text" as const, text: `Artifact unavailable: ${params.id}` }],
					details: { found: false },
				};
			}
			const full = record.content.map((block) => block.text).join("\n");
			if (params.query) {
				const haystack = full.toLocaleLowerCase();
				const needle = params.query.toLocaleLowerCase();
				const matchOffsets: number[] = [];
				let cursor = 0;
				while (matchOffsets.length < 10) {
					const found = haystack.indexOf(needle, cursor);
					if (found < 0) break;
					matchOffsets.push(found);
					cursor = found + Math.max(1, needle.length);
				}
				const snippets = matchOffsets.map((match, index) => {
					const start = Math.max(0, match - 240);
					const end = Math.min(full.length, match + needle.length + 240);
					return `[${index + 1}] chars ${start}-${end}\n${full.slice(start, end)}`;
				});
				return {
					content: [{
						type: "text" as const,
						text: snippets.length > 0
							? `[Artifact ${record.id} · ${snippets.length} match(es) for ${JSON.stringify(params.query)}]\n\n${snippets.join("\n\n")}`
							: `[Artifact ${record.id} · no matches for ${JSON.stringify(params.query)}]`,
					}],
					details: {
						found: true,
						id: record.id,
						totalCharacters: full.length,
						sha256: record.sha256,
						matchOffsets,
					},
				};
			}
			const offset = Math.min(params.offset ?? 0, full.length);
			const limit = params.limit ?? policy.readChunkCharacters;
			const chunk = full.slice(offset, offset + limit);
			return {
				content: [{
					type: "text" as const,
					text:
						`[Artifact ${record.id} · chars ${offset}-${offset + chunk.length}/${full.length} · sha256 ${record.sha256}]\n\n` +
						chunk,
				}],
				details: {
					found: true,
					id: record.id,
					offset,
					nextOffset: offset + chunk.length < full.length ? offset + chunk.length : null,
					totalCharacters: full.length,
					sha256: record.sha256,
				},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentSessionRef = sessionRef(ctx);
		artifacts = new Map(
			(await listArtifacts(currentSessionRef)).map((artifact) => [artifact.id, artifact]),
		);
		artifactsByHash = new Map(
			[...artifacts.values()].map((artifact) => [artifact.sha256, artifact]),
		);
		archivedResults = 0;
		tokensSaved = 0;
		archiveFailures = 0;
		reusedArtifacts = 0;
		recoveredBashResults = 0;
		setRetrievalActive(artifacts.size > 0);
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentSessionRef = sessionRef(ctx);
		artifacts = new Map(
			(await listArtifacts(currentSessionRef)).map((artifact) => [artifact.id, artifact]),
		);
		artifactsByHash = new Map(
			[...artifacts.values()].map((artifact) => [artifact.sha256, artifact]),
		);
		setRetrievalActive(artifacts.size > 0);
	});

	pi.on("tool_result", async (event, ctx) => {
		const contextPercent = ctx.getContextUsage()?.percent;
		let content = event.content as TextBlock[];
		let decision = decideArtifact(
			event.toolName,
			content,
			event.isError,
			contextPercent,
			policy,
			safetyReady,
		);
		let recoveredBash = false;
		const bashCandidate = event.toolName === "bash"
			? bashFullOutputCandidate(event.details)
			: null;
		if (bashCandidate) {
			const preflight = decideArtifact(
				event.toolName,
				content,
				event.isError,
				contextPercent,
				policy,
				safetyReady,
				bashCandidate.estimatedTokens,
			);
			if (preflight.archive) {
				try {
					const recovered = await recoverSafeBashOutput(pi, bashCandidate);
					if (!recovered) {
						archiveFailures++;
						return;
					}
					content = recovered;
					decision = decideArtifact(
						event.toolName,
						content,
						event.isError,
						contextPercent,
						policy,
						safetyReady,
					);
					if (!decision.archive) return;
					recoveredBash = true;
				} catch {
					archiveFailures++;
					return;
				}
			}
		}
		if (!decision.archive) return;
		try {
			const activeSessionRef = currentSessionRef || sessionRef(ctx);
			const copiedContent = content.map((block) => ({ type: "text" as const, text: block.text }));
			const contentHash = hashTextBlocks(copiedContent);
			const existing = artifactsByHash.get(contentHash);
			const artifact = existing ?? await writeArtifact(
				activeSessionRef,
				event.toolName,
				copiedContent,
				decision.originalTokens,
			);
			currentSessionRef = activeSessionRef;
			artifacts.set(artifact.id, artifact);
			artifactsByHash.set(artifact.sha256, artifact);
			if (existing) reusedArtifacts++;
			if (recoveredBash) recoveredBashResults++;
			setRetrievalActive(true);
			const preview = buildArtifactPreview(content, artifact.id, decision.originalTokens, policy);
			const visibleTokens = estimateTextTokens(preview);
			if (visibleTokens >= decision.originalTokens) {
				archiveFailures++;
				return;
			}
			archivedResults++;
			tokensSaved += decision.originalTokens - visibleTokens;
			pi.events.emit(TOKEN_ROI_ARTIFACT_EVENT, {
				originalTokens: decision.originalTokens,
				visibleTokens,
				reused: existing !== undefined,
			});
			return {
				content: [{ type: "text" as const, text: preview }],
			};
		} catch {
			// Durability is the gate: preserve the original tool result if storage
			// or preview generation fails.
			archiveFailures++;
			return;
		}
	});

	pi.registerCommand("artifacts", {
		description: "Show bounded-output artifact status for this session",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				[
					`context artifacts: ${safetyReady ? "enabled" : "disabled (safe-operation capability unavailable)"}`,
					`policy: hard ${policy.hardTokens} tokens · pressure ${policy.pressureTokens} at ${policy.pressurePercent}% · visible ${policy.visibleTokens}`,
					`session artifacts: ${artifacts.size}`,
					`archived this run: ${archivedResults}`,
					`duplicate results reused: ${reusedArtifacts}`,
					`full Bash outputs recovered before Pi truncation: ${recoveredBashResults}`,
					`archive failures (original preserved): ${archiveFailures}`,
					`estimated context tokens saved this run: ${tokensSaved}`,
					`retrieval tool: ${artifacts.size > 0 ? "active" : "inactive"}`,
				].join("\n"),
				safetyReady ? "info" : "warning",
			);
		},
	});
}

export {
	buildArtifactPreview,
	decideArtifact,
	loadPolicy,
	listArtifacts,
	readArtifact,
	hashTextBlocks,
	writeArtifact,
};
