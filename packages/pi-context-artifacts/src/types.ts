export interface ArtifactPolicy {
	hardTokens: number;
	pressureTokens: number;
	pressurePercent: number;
	visibleTokens: number;
	readChunkCharacters: number;
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ArtifactRecord {
	version: 1;
	id: string;
	createdAt: string;
	toolName: string;
	originalTokens: number;
	originalCharacters: number;
	sha256: string;
	content: TextBlock[];
}

export interface ArtifactSummary {
	id: string;
	createdAt: string;
	toolName: string;
	originalTokens: number;
	originalCharacters: number;
	sha256: string;
}

export interface ArtifactDecision {
	archive: boolean;
	reason: string;
	originalTokens: number;
}
