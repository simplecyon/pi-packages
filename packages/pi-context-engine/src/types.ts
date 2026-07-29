export type ContextRecordKind =
	| "document"
	| "session"
	| "legacy-document"
	| "legacy-session";

export interface ContextRecord {
	version: 1;
	id: string;
	kind: ContextRecordKind;
	source: string;
	title: string;
	content: string;
	createdAt: string;
	contentHash: string;
	sessionRef?: string;
	path?: string;
	category?: string;
	eventType?: string;
}

export interface ContextStore {
	version: 1;
	projectDir: string;
	updatedAt: string;
	records: ContextRecord[];
	migrations: Record<string, {
		completedAt: string;
		recordsImported: number;
		sourceFiles: number;
	}>;
}

export interface ContextSearchHit {
	id: string;
	kind: ContextRecordKind;
	source: string;
	title: string;
	createdAt: string;
	score: number;
	snippet: string;
	category?: string;
	eventType?: string;
}

export interface StoreStats {
	records: number;
	documents: number;
	sessionEvents: number;
	legacyRecords: number;
	sources: number;
	characters: number;
	migrations: string[];
}

export interface MigrationResult {
	alreadyMigrated: boolean;
	recordsImported: number;
	sourceFiles: number;
	sessionDatabases: number;
	contentDatabases: number;
	skippedDatabases: number;
}
