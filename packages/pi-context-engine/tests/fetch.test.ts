import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPublicUrl,
	fetchTextResource,
	isPrivateAddress,
} from "../src/fetch.ts";

test("classifies private IPv4, IPv6, mapped, and carrier-grade ranges", () => {
	for (const address of [
		"127.0.0.1",
		"10.0.0.1",
		"172.16.1.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
	]) {
		assert.equal(isPrivateAddress(address), true, address);
	}
	assert.equal(isPrivateAddress("8.8.8.8"), false);
	assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("rejects local URLs before any fetch", async () => {
	for (const value of [
		"http://localhost/data",
		"http://127.0.0.1/data",
		"http://[::1]/data",
		"http://169.254.169.254/latest/meta-data",
		"file:///etc/passwd",
	]) {
		await assert.rejects(assertPublicUrl(new URL(value)), /not allowed|HTTP/);
	}
});

test("follows checked redirects and converts bounded HTML to text", async () => {
	const checked: string[] = [];
	const responses = [
		new Response(null, {
			status: 302,
			headers: { location: "/final" },
		}),
		new Response("<h1>Title</h1><script>secret()</script><p>A &amp; B</p>", {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		}),
	];
	const fetched = await fetchTextResource("https://example.test/start", {
		assertUrl: async (url) => {
			checked.push(url.toString());
		},
		fetchImpl: async () => responses.shift()!,
	});
	assert.deepEqual(checked, [
		"https://example.test/start",
		"https://example.test/final",
	]);
	assert.equal(fetched.finalUrl, "https://example.test/final");
	assert.equal(fetched.contentType, "text/html");
	assert.match(fetched.content, /Title/);
	assert.match(fetched.content, /A & B/);
	assert.doesNotMatch(fetched.content, /secret/);
});

test("rejects unsupported MIME types and oversized responses", async () => {
	await assert.rejects(
		fetchTextResource("https://example.test/image", {
			assertUrl: async () => {},
			fetchImpl: async () =>
				new Response("image", {
					headers: { "content-type": "image/png" },
				}),
		}),
		/Unsupported response content type/,
	);
	await assert.rejects(
		fetchTextResource("https://example.test/large", {
			assertUrl: async () => {},
			maxBytes: 4,
			fetchImpl: async () =>
				new Response("12345", {
					headers: { "content-type": "text/plain" },
				}),
		}),
		/exceeds 4 bytes/,
	);
});
