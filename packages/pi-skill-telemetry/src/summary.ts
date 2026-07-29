import type { SkillUsageRow, TelemetryEvent } from "./types.ts";

export function summarizeEvents(events: TelemetryEvent[]): SkillUsageRow[] {
	const completed = new Map<string, TelemetryEvent>();
	for (const event of events) {
		if (event.event_type === "skill_load_completed" && event.invocation_id) {
			completed.set(event.invocation_id, event);
		}
	}
	const rows = new Map<string, SkillUsageRow & { sessions: Set<string> }>();
	for (const event of events) {
		if (event.event_type !== "skill_invocation_detected" || !event.skill_id) continue;
		const row = rows.get(event.skill_id) ?? {
			skill_id: event.skill_id,
			skill_name: event.skill_name ?? event.skill_id,
			invocations: 0,
			explicit: 0,
			model_read: 0,
			load_successes: 0,
			load_failures: 0,
			unique_sessions: 0,
			last_used_at: "",
			sessions: new Set<string>(),
		};
		row.invocations += 1;
		if (event.trigger_mode === "explicit") row.explicit += 1;
		if (event.trigger_mode === "model_read") row.model_read += 1;
		if (event.global_session_id) row.sessions.add(event.global_session_id);
		if (event.recorded_at > row.last_used_at) row.last_used_at = event.recorded_at;
		const completion = event.invocation_id ? completed.get(event.invocation_id) : undefined;
		if (completion?.load_success === true) row.load_successes += 1;
		if (completion?.load_success === false) row.load_failures += 1;
		rows.set(event.skill_id, row);
	}
	return [...rows.values()]
		.map(({ sessions, ...row }) => ({ ...row, unique_sessions: sessions.size }))
		.sort((a, b) => b.invocations - a.invocations || a.skill_name.localeCompare(b.skill_name));
}
