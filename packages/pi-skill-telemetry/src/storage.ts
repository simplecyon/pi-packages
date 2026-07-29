import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	SCHEMA_VERSION,
	type TelemetryEvent,
	type TelemetryIdentity,
} from "./types.ts";

export function storageRoot(): string {
	return process.env.PI_SKILL_TELEMETRY_DIR
		|| join(homedir(), ".pi", "agent", "skill-telemetry");
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

export async function loadIdentity(root = storageRoot()): Promise<TelemetryIdentity> {
	const path = join(root, "identity.json");
	const existing = await readJson(path) as Partial<TelemetryIdentity> | undefined;
	if (existing?.schema_version === SCHEMA_VERSION && typeof existing.install_id === "string") {
		return existing as TelemetryIdentity;
	}
	await mkdir(root, { recursive: true });
	const identity: TelemetryIdentity = {
		schema_version: SCHEMA_VERSION,
		install_id: randomUUID(),
		created_at: new Date().toISOString(),
	};
	try {
		await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		return identity;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const raced = await readJson(path) as TelemetryIdentity | undefined;
		if (!raced?.install_id) throw new Error(`invalid telemetry identity at ${path}`);
		return raced;
	}
}

export async function loadDeviceHint(): Promise<string | undefined> {
	const value = await readJson(join(homedir(), ".agentsync", "config.json")) as
		| { device?: unknown }
		| undefined;
	return typeof value?.device === "string" && value.device.trim()
		? value.device.trim()
		: undefined;
}

async function validPayload(path: string): Promise<{ events: TelemetryEvent[]; payload: Buffer }> {
	const raw = await readFile(path, "utf8");
	const events: TelemetryEvent[] = [];
	const lines: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as Partial<TelemetryEvent>;
			if (
				event.schema_version === SCHEMA_VERSION
				&& typeof event.event_id === "string"
				&& event.event_type !== "segment_seal"
			) {
				events.push(event as TelemetryEvent);
				lines.push(`${JSON.stringify(event)}\n`);
			}
		} catch {
			// A process may die in the middle of its last append. Keep every
			// complete event before that partial line.
		}
	}
	return { events, payload: Buffer.from(lines.join(""), "utf8") };
}

async function sealOpenFile(path: string): Promise<string | undefined> {
	const { events, payload } = await validPayload(path);
	if (events.length === 0) {
		await unlink(path).catch(() => {});
		return undefined;
	}
	const first = events[0];
	const lastSequence = Math.max(...events.map((event) => event.sequence));
	const digest = createHash("sha256").update(payload).digest("hex");
	const recordedAt = new Date().toISOString();
	const seal: TelemetryEvent = {
		schema_version: SCHEMA_VERSION,
		event_id: randomUUID(),
		event_type: "segment_seal",
		recorded_at: recordedAt,
		install_id: first.install_id,
		collector_instance_id: first.collector_instance_id,
		sequence: lastSequence + 1,
		device_hint: first.device_hint,
		event_count: events.length,
		payload_sha256: digest,
	};
	const date = new Date(first.recorded_at);
	const year = Number.isNaN(date.valueOf()) ? "unknown" : String(date.getUTCFullYear());
	const month = Number.isNaN(date.valueOf())
		? "unknown"
		: String(date.getUTCMonth() + 1).padStart(2, "0");
	const targetDir = join(dirname(dirname(path)), "sealed", year, month);
	await mkdir(targetDir, { recursive: true });
	const stem = basename(path).replace(/\.jsonl\.open$/, "");
	const target = join(targetDir, `${stem}-${digest.slice(0, 12)}.jsonl`);
	await writeFile(path, Buffer.concat([payload, Buffer.from(`${JSON.stringify(seal)}\n`, "utf8")]));
	await rename(path, target);
	return target;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function recoverStaleOpenFiles(root = storageRoot()): Promise<string[]> {
	const openDir = join(root, "open");
	let names: string[];
	try {
		names = await readdir(openDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const recovered: string[] = [];
	for (const name of names.filter((entry) => entry.endsWith(".jsonl.open"))) {
		const match = /^(\d+)-/.exec(name);
		if (match && pidAlive(Number(match[1]))) continue;
		const target = await sealOpenFile(join(openDir, name));
		if (target) recovered.push(target);
	}
	return recovered;
}

export class TelemetryWriter {
	private sequence = 0;
	private segmentId = randomUUID();
	private openPath: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	readonly root: string;
	readonly identity: TelemetryIdentity;
	readonly collectorInstanceId: string;
	readonly deviceHint: string | undefined;

	private constructor(
		root: string,
		identity: TelemetryIdentity,
		collectorInstanceId: string,
		deviceHint: string | undefined,
	) {
		this.root = root;
		this.identity = identity;
		this.collectorInstanceId = collectorInstanceId;
		this.deviceHint = deviceHint;
	}

	static async create(root = storageRoot()): Promise<TelemetryWriter> {
		await mkdir(join(root, "open"), { recursive: true });
		await recoverStaleOpenFiles(root);
		const writer = new TelemetryWriter(
			root,
			await loadIdentity(root),
			randomUUID(),
			await loadDeviceHint(),
		);
		return writer;
	}

	private ensureOpenPath(): string {
		if (!this.openPath) {
			this.segmentId = randomUUID();
			this.openPath = join(
				this.root,
				"open",
				`${process.pid}-${this.collectorInstanceId}-${this.segmentId}.jsonl.open`,
			);
		}
		return this.openPath;
	}

	record(
		event: Omit<
			TelemetryEvent,
			| "schema_version"
			| "event_id"
			| "recorded_at"
			| "install_id"
			| "collector_instance_id"
			| "sequence"
			| "device_hint"
		>,
	): Promise<void> {
		const operation = this.queue.then(async () => {
			const full: TelemetryEvent = {
				schema_version: SCHEMA_VERSION,
				event_id: randomUUID(),
				recorded_at: new Date().toISOString(),
				install_id: this.identity.install_id,
				collector_instance_id: this.collectorInstanceId,
				sequence: ++this.sequence,
				device_hint: this.deviceHint,
				...event,
			};
			await appendFile(this.ensureOpenPath(), `${JSON.stringify(full)}\n`, "utf8");
		});
		this.queue = operation.catch(() => {});
		return operation;
	}

	flush(): Promise<unknown> {
		return this.queue;
	}

	seal(): Promise<string | undefined> {
		const operation = this.queue.then(async () => {
			const path = this.openPath;
			if (!path) return undefined;
			this.openPath = undefined;
			return sealOpenFile(path);
		});
		this.queue = operation.catch(() => {});
		return operation;
	}
}

async function walk(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await walk(path));
		else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.open"))) {
			files.push(path);
		}
	}
	return files;
}

export async function readLocalEvents(root = storageRoot()): Promise<TelemetryEvent[]> {
	const files = [
		...await walk(join(root, "open")),
		...await walk(join(root, "sealed")),
		...await walk(join(root, "published")),
	];
	const seen = new Set<string>();
	const events: TelemetryEvent[] = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8").catch(() => "");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as TelemetryEvent;
				if (
					event.schema_version === SCHEMA_VERSION
					&& event.event_type !== "segment_seal"
					&& !seen.has(event.event_id)
				) {
					seen.add(event.event_id);
					events.push(event);
				}
			} catch {
				// Ignore a partial last line in an active spool.
			}
		}
	}
	return events;
}
