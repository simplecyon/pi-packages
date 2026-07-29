export function formatErrorOutcome(result: { content: Array<{ type: string; text?: string }> }): string {
	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");

	const timeout = output.match(/Command timed out after\s+([\d.]+)\s+seconds?/i);
	if (timeout?.[1]) return `timeout ${timeout[1]}s`;

	const exit = output.match(/Command exited with code\s+(-?\d+)/i);
	if (exit?.[1]) return `exit ${exit[1]}`;

	if (/(?:Command|Operation) aborted/i.test(output)) return "aborted";
	return "failed";
}
