export const CAPABILITY_AVAILABLE = "cyon:context-compact:available";
export const CAPABILITY_DISCOVER = "cyon:context-compact:discover";
export const CHECKPOINT_OWNER = "context-compact-cyon";
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const MAX_CHECKPOINT_CHARS = 6000;

export interface StoredToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface StoredMessage {
	ordinal: number;
	role: string;
	text: string;
	toolCalls?: StoredToolCall[];
	isError?: boolean;
}

export interface HistorySegment {
	type: "segment";
	schemaVersion: 1;
	id: string;
	sessionRef: string;
	createdAt: string;
	reason: "manual" | "threshold" | "overflow";
	isSplitTurn: boolean;
	messages: StoredMessage[];
}

export interface StoredCheckpoint {
	type: "checkpoint";
	schemaVersion: 1;
	id: string;
	segmentId: string;
	createdAt: string;
	summary: string;
}

export interface SearchHit {
	segmentId: string;
	createdAt: string;
	role: string;
	text: string;
	score: number;
}

export interface ContextCompactDetails {
	owner: typeof CHECKPOINT_OWNER;
	schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
	segmentId: string;
	messageCount: number;
	archivedChars: number;
	checkpointChars: number;
}
