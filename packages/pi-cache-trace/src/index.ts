import { createHash, randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const TRACE_ENTRY_TYPE = "cache-trace";

interface TraceUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface CacheTraceEntry {
	version: 1;
	recordedAt: string;
	provider: string;
	model: string;
	responseStatus: number | null;
	transport: string | null;
	instructionsHash: string;
	toolSchemaHash: string;
	promptCacheKeyHash: string | null;
	stablePrefixHash: string | null;
	inputItemCount: number;
	sharedPrefixItems: number;
	usage: TraceUsage;
}

interface PendingTrace {
	instructionsHash: string;
	toolSchemaHash: string;
	promptCacheKeyHash: string | null;
	stablePrefixHash: string | null;
	inputItemCount: number;
	sharedPrefixItems: number;
	transport: string | null;
	responseStatus: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) =>
		`${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function fingerprint(salt: string, value: unknown): string {
	return createHash("sha256").update(salt).update("\0").update(canonicalize(value)).digest("hex");
}

function inputItems(payload: Record<string, unknown>): unknown[] {
	if (Array.isArray(payload.input)) return payload.input;
	if (Array.isArray(payload.messages)) return payload.messages;
	return [];
}

function sharedPrefixLength(previous: readonly string[], current: readonly string[]): number {
	let index = 0;
	while (index < previous.length && index < current.length && previous[index] === current[index]) index += 1;
	return index;
}

function usageOf(value: unknown): TraceUsage {
	const usage = asRecord(value);
	return {
		input: typeof usage?.input === "number" ? usage.input : 0,
		cacheRead: typeof usage?.cacheRead === "number" ? usage.cacheRead : 0,
		cacheWrite: typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0,
	};
}

function traceFromEntry(value: unknown): CacheTraceEntry | null {
	const record = asRecord(value);
	if (!record || record.version !== 1 || typeof record.provider !== "string" || typeof record.model !== "string") return null;
	const usage = usageOf(record.usage);
	return {
		version: 1,
		recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : "",
		provider: record.provider,
		model: record.model,
		responseStatus: typeof record.responseStatus === "number" ? record.responseStatus : null,
		transport: typeof record.transport === "string" ? record.transport : null,
		instructionsHash: typeof record.instructionsHash === "string" ? record.instructionsHash : "",
		toolSchemaHash: typeof record.toolSchemaHash === "string" ? record.toolSchemaHash : "",
		promptCacheKeyHash: typeof record.promptCacheKeyHash === "string" ? record.promptCacheKeyHash : null,
		stablePrefixHash: typeof record.stablePrefixHash === "string" ? record.stablePrefixHash : null,
		inputItemCount: typeof record.inputItemCount === "number" ? record.inputItemCount : 0,
		sharedPrefixItems: typeof record.sharedPrefixItems === "number" ? record.sharedPrefixItems : 0,
		usage,
	};
}

function formatReport(traces: readonly CacheTraceEntry[]): string {
	if (traces.length === 0) return "No completed provider requests traced in this session.";
	const totalPrompt = traces.reduce((sum, trace) => sum + trace.usage.input + trace.usage.cacheRead + trace.usage.cacheWrite, 0);
	const totalRead = traces.reduce((sum, trace) => sum + trace.usage.cacheRead, 0);
	const fullMisses = traces.filter((trace) => trace.usage.cacheRead === 0).length;
	const latest = traces.at(-1)!;
	const hitRate = totalPrompt > 0 ? `${((totalRead / totalPrompt) * 100).toFixed(1)}%` : "n/a";
	return [
		`Cache trace: ${traces.length} completed provider request(s) · ${fullMisses} full miss(es) · aggregate cache read ${hitRate}`,
		`Latest: ${latest.provider}/${latest.model} · status ${latest.responseStatus ?? "unknown"} · input ${latest.usage.input} · cache read ${latest.usage.cacheRead} · shared prefix items ${latest.sharedPrefixItems}/${latest.inputItemCount}`,
		"Stored metadata contains salted fingerprints only; prompts and tool results are not persisted.",
	].join("\n");
}

export default function cacheTraceExtension(pi: ExtensionAPI): void {
	let salt = randomUUID();
	let previousInputHashes: string[] = [];
	let pending: PendingTrace | null = null;

	pi.on("session_start", () => {
		salt = randomUUID();
		previousInputHashes = [];
		pending = null;
	});

	pi.on("before_provider_request", (event) => {
		const payload = asRecord(event.payload);
		if (!payload) return;
		const items = inputItems(payload);
		const hashes = items.map((item) => fingerprint(salt, item));
		const shared = sharedPrefixLength(previousInputHashes, hashes);
		const transport = typeof payload.transport === "string" ? payload.transport : null;
		const cacheKey = payload.prompt_cache_key ?? payload.promptCacheKey;
		pending = {
			instructionsHash: fingerprint(salt, payload.instructions ?? payload.system ?? null),
			toolSchemaHash: fingerprint(salt, payload.tools ?? null),
			promptCacheKeyHash: cacheKey === undefined ? null : fingerprint(salt, cacheKey),
			stablePrefixHash: shared === 0 ? null : fingerprint(salt, hashes.slice(0, shared)),
			inputItemCount: hashes.length,
			sharedPrefixItems: shared,
			transport,
			responseStatus: null,
		};
		previousInputHashes = hashes;
	});

	pi.on("after_provider_response", (event) => {
		if (pending) pending.responseStatus = event.status;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !pending) return;
		const trace: CacheTraceEntry = {
			version: 1,
			recordedAt: new Date().toISOString(),
			provider: event.message.provider,
			model: event.message.model,
			responseStatus: pending.responseStatus,
			transport: pending.transport,
			instructionsHash: pending.instructionsHash,
			toolSchemaHash: pending.toolSchemaHash,
			promptCacheKeyHash: pending.promptCacheKeyHash,
			stablePrefixHash: pending.stablePrefixHash,
			inputItemCount: pending.inputItemCount,
			sharedPrefixItems: pending.sharedPrefixItems,
			usage: usageOf(event.message.usage),
		};
		pi.appendEntry(TRACE_ENTRY_TYPE, trace);
		pending = null;
	});

	pi.registerCommand("cache-trace", {
		description: "Show privacy-preserving prompt-cache diagnostics for this session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cache-trace", "warning");
				return;
			}
			const traces: CacheTraceEntry[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== TRACE_ENTRY_TYPE) continue;
				const trace = traceFromEntry((entry as { data?: unknown }).data);
				if (trace) traces.push(trace);
			}
			ctx.ui.notify(formatReport(traces), "info");
		},
	});
}

export { TRACE_ENTRY_TYPE, formatReport, sharedPrefixLength };
