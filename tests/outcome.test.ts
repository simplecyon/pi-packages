import assert from "node:assert/strict";
import test from "node:test";
import { formatErrorOutcome } from "../src/outcome.ts";

function result(text: string) {
	return { content: [{ type: "text", text }] };
}

test("extracts compact bash error outcomes", () => {
	assert.equal(formatErrorOutcome(result("build output\n\nCommand timed out after 30 seconds")), "timeout 30s");
	assert.equal(formatErrorOutcome(result("failure\n\nCommand exited with code 2")), "exit 2");
	assert.equal(formatErrorOutcome(result("Command aborted")), "aborted");
	assert.equal(formatErrorOutcome(result("unexpected failure")), "failed");
});
