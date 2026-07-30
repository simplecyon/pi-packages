import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildCheckpoint } from "./checkpoint.ts";
import { serializeMessages } from "./messages.ts";
import { searchHistory } from "./search.ts";
import { appendCheckpoint, appendSegment } from "./storage.ts";
import {
	CHECKPOINT_OWNER,
	CHECKPOINT_SCHEMA_VERSION,
	type ContextCompactDetails,
	type HistorySegment,
} from "./types.ts";

const CONTEXT_ENGINE_COMPACT_SEARCH = "simplecyon:context-engine:compact-search";

const AUTO_CONTINUE_PROMPT =
	"Context compaction finished. Continue the unfinished task from the checkpoint above; do not repeat completed work.";

function autoContinueDisabled(): boolean {
	const value = process.env.PI_CONTEXT_COMPACT_AUTO_CONTINUE?.trim().toLowerCase();
	return value === "off" || value === "0" || value === "false";
}

interface ContextEngineCompactSearchRequest {
	query?: unknown;
	limit?: unknown;
	searches?: unknown;
}

function currentSessionRef(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	ephemeralSessionId: string,
): string {
	const manager = ctx.sessionManager as typeof ctx.sessionManager & {
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
	return manager.getSessionFile?.() ??
		manager.getSessionId?.() ??
		`ephemeral:${ctx.cwd}:${ephemeralSessionId}`;
}

function searchSummary(query: string): string {
	const normalized = query.replace(/\s+/g, " ").trim();
	return normalized.length > 72 ? `${normalized.slice(0, 71)}…` : normalized;
}

function formatTokenCount(value: number): string {
	if (value < 1000) return String(value);
	const scaled = value / 1000;
	const digits = scaled >= 100 || Number.isInteger(scaled) ? 0 : 1;
	return `${scaled.toFixed(digits)}k`;
}

export default function contextCompactExtension(pi: ExtensionAPI): void {
	let ephemeralSessionId = randomUUID();
	let activeSessionRef = "";

	function hasOwnedCompaction(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "compaction") return false;
			const details = entry.details as Partial<ContextCompactDetails> | undefined;
			return details?.owner === CHECKPOINT_OWNER;
		});
	}

	function setSearchActive(active: boolean): void {
		const current = pi.getActiveTools();
		const next = active
			? [...new Set([...current, "compact_search"])]
			: current.filter((name) => name !== "compact_search");
		if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
			pi.setActiveTools(next);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ephemeralSessionId = randomUUID();
		activeSessionRef = currentSessionRef(ctx, ephemeralSessionId);
		setSearchActive(hasOwnedCompaction(ctx));
	});
	pi.on("session_tree", (_event, ctx) => {
		activeSessionRef = currentSessionRef(ctx, ephemeralSessionId);
		setSearchActive(hasOwnedCompaction(ctx));
	});
	pi.events.on(CONTEXT_ENGINE_COMPACT_SEARCH, (data) => {
		if (!data || typeof data !== "object" || !activeSessionRef) return;
		const request = data as ContextEngineCompactSearchRequest;
		if (
			typeof request.query !== "string" ||
			!Array.isArray(request.searches)
		) {
			return;
		}
		const limit =
			typeof request.limit === "number" && Number.isFinite(request.limit)
				? Math.max(1, Math.min(Math.floor(request.limit), 20))
				: 5;
		request.searches.push(
			searchHistory(activeSessionRef, request.query, limit),
		);
	});
	pi.registerTool({
		name: "compact_search",
		label: "Compact History Search",
		description: "Search older messages that context compaction moved out of the active Pi context.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Words or exact phrase to find in compacted history" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
		}),
		renderShell: "self",
		renderCall(args, theme) {
			return new Text(`·compact search ${theme.fg("dim", searchSummary(args.query))}`, 0, 0);
		},
		renderResult(result, options, theme) {
			if (!options.expanded) return new Text("", 0, 0);
			const output = result.content
				.filter((block) => block.type === "text")
				.map((block) => ("text" in block ? block.text : ""))
				.join("\n");
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Search cancelled." }], details: { hits: [] } };
			}
			const hits = await searchHistory(currentSessionRef(ctx, ephemeralSessionId), params.query, params.limit ?? 5);
			if (hits.length === 0) {
				return { content: [{ type: "text", text: "No matching compacted history." }], details: { hits: [] } };
			}
			const rendered: string[] = [];
			let outputBudget = 12_000;
			for (const [index, hit] of hits.entries()) {
				const block = `[${index + 1}] ${hit.role} · ${hit.segmentId} · score ${hit.score.toFixed(2)}\n${hit.text}`;
				if (block.length > outputBudget) break;
				rendered.push(block);
				outputBudget -= block.length + 2;
			}
			const text = rendered.join("\n\n");
			return { content: [{ type: "text", text }], details: { hits } };
		},
	});

	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
		try {
			const preparation = event.preparation;
			if (!preparation.firstKeptEntryId || !Number.isFinite(preparation.tokensBefore)) return;

			const messages = serializeMessages([
				...preparation.messagesToSummarize,
				...preparation.turnPrefixMessages,
			]);
			if (messages.length === 0) return;

			const sessionRef = currentSessionRef(ctx, ephemeralSessionId);
			activeSessionRef = sessionRef;
			const segmentId = randomUUID();
			const createdAt = new Date().toISOString();
			const segment: HistorySegment = {
				type: "segment",
				schemaVersion: 1,
				id: segmentId,
				sessionRef,
				createdAt,
				reason: event.reason,
				isSplitTurn: preparation.isSplitTurn,
				messages,
			};

			// Durability gate: never replace Pi's native summary until the exact
			// discarded span is safely recoverable.
			await appendSegment(segment);
			const summary = buildCheckpoint(messages, segmentId, preparation.previousSummary);
			await appendCheckpoint(sessionRef, {
				type: "checkpoint",
				schemaVersion: 1,
				id: randomUUID(),
				segmentId,
				createdAt,
				summary,
			});
			const archivedChars = messages.reduce((total, message) => total + message.text.length, 0);
			const details: ContextCompactDetails = {
				owner: CHECKPOINT_OWNER,
				schemaVersion: CHECKPOINT_SCHEMA_VERSION,
				segmentId,
				messageCount: messages.length,
				archivedChars,
				checkpointChars: summary.length,
			};

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details,
				},
			};
		} catch {
			// Returning no result preserves Pi's native LLM compaction path.
			return;
		}
	});

	pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
		try {
			// Threshold compaction fires at agent_end, after Pi has already decided
			// the turn is over. Queueing a follow-up here makes Pi's post-compaction
			// hasQueuedMessages() check continue the run instead of waiting for the
			// user. Skipped while idle (pre-prompt compaction), where the user's own
			// prompt already drives the next turn, and for manual/overflow reasons,
			// which either are user-initiated or retry on their own.
			if (event.reason === "threshold" && !ctx.isIdle() && !autoContinueDisabled()) {
				pi.sendUserMessage(AUTO_CONTINUE_PROMPT, { deliverAs: "followUp" });
			}
			const details = event.compactionEntry.details as Partial<ContextCompactDetails> | undefined;
			if (details?.owner !== CHECKPOINT_OWNER) return;
			setSearchActive(true);
			if (!event.fromExtension || !ctx.hasUI) return;
			const messageCount = Number(details.messageCount ?? 0);
			const label = messageCount === 1 ? "message" : "messages";
			ctx.ui.notify(
				`Compacted ${formatTokenCount(event.compactionEntry.tokensBefore)} tokens · archived ${messageCount} ${label}`,
				"info",
			);
		} catch {
			// UI feedback must never affect a completed compaction.
		}
	});
}

export { buildCheckpoint } from "./checkpoint.ts";
export { serializeMessages } from "./messages.ts";
export { searchHistory } from "./search.ts";
export { readSegments, sessionKey, storageRoot } from "./storage.ts";
