import {
	estimateTextTokens,
	TOKEN_ROI_ARTIFACT_EVENT,
} from "@simplecyon/pi-context-core";
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
const RETRIEVAL_TOOL = "artifact_read";

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
		const decision = decideArtifact(
			event.toolName,
			event.content,
			event.isError,
			ctx.getContextUsage()?.percent,
			policy,
			safetyReady,
		);
		if (!decision.archive) return;
		try {
			const content = event.content as TextBlock[];
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
