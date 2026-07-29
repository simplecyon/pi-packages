export const SCHEMA_VERSION = 1 as const;

export type TriggerMode = "explicit" | "model_read" | "shell_heuristic";

export type TelemetryEventType =
	| "collector_started"
	| "session_started"
	| "skill_catalog_snapshot"
	| "skill_invocation_detected"
	| "skill_load_started"
	| "skill_load_completed"
	| "agent_settled"
	| "session_shutdown"
	| "segment_seal";

export interface TelemetryEvent {
	schema_version: typeof SCHEMA_VERSION;
	event_id: string;
	event_type: TelemetryEventType;
	recorded_at: string;
	install_id: string;
	collector_instance_id: string;
	sequence: number;
	device_hint?: string;
	pid?: number;
	global_session_id?: string;
	session_instance_id?: string;
	turn_index?: number;
	skill_id?: string;
	skill_name?: string;
	skill_version?: string;
	skill_ids?: string[];
	trigger_mode?: TriggerMode;
	confidence?: "high" | "medium" | "low";
	invocation_id?: string;
	tool_call_id?: string;
	load_success?: boolean;
	duration_ms?: number;
	provider?: string;
	model?: string;
	reason?: string;
	event_count?: number;
	payload_sha256?: string;
}

export interface TelemetryIdentity {
	schema_version: typeof SCHEMA_VERSION;
	install_id: string;
	created_at: string;
}

export interface SkillUsageRow {
	skill_id: string;
	skill_name: string;
	invocations: number;
	explicit: number;
	model_read: number;
	load_successes: number;
	load_failures: number;
	unique_sessions: number;
	last_used_at: string;
}
