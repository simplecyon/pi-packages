import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/xml",
	"application/xhtml+xml",
	"application/javascript",
];

function parseIPv4(address: string): number[] | null {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return null;
	}
	return parts;
}

export function isPrivateAddress(address: string): boolean {
	const ipv4 = parseIPv4(address);
	if (ipv4) {
		const [a, b] = ipv4;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			a >= 224
		);
	}
	const normalized = address.toLocaleLowerCase();
	if (normalized === "::1" || normalized === "::") return true;
	if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	return mapped ? isPrivateAddress(mapped[1]) : false;
}

export async function assertPublicUrl(url: URL): Promise<void> {
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Only HTTP(S) URLs are supported: ${url.protocol}`);
	}
	const hostname = url.hostname
		.toLocaleLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname === "metadata.google.internal"
	) {
		throw new Error(`Private or local hostname is not allowed: ${hostname}`);
	}
	if (isIP(hostname)) {
		if (isPrivateAddress(hostname)) {
			throw new Error(`Private or local address is not allowed: ${hostname}`);
		}
		return;
	}
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0) throw new Error(`Hostname did not resolve: ${hostname}`);
	for (const result of addresses) {
		if (isPrivateAddress(result.address)) {
			throw new Error(
				`Hostname resolves to a private or local address: ${hostname}`,
			);
		}
	}
}

function decodeHtml(text: string): string {
	return text
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

async function readBoundedBody(
	response: Response,
	maxBytes: number,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`Fetched response exceeds ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

export async function fetchTextResource(
	input: string,
	options?: {
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
		fetchImpl?: typeof fetch;
		assertUrl?: (url: URL) => Promise<void>;
	},
): Promise<{ content: string; finalUrl: string; contentType: string }> {
	let current = new URL(input);
	const timeoutController = new AbortController();
	const timeout = setTimeout(
		() => timeoutController.abort(),
		Math.max(1_000, Math.min(options?.timeoutMs ?? 20_000, 60_000)),
	);
	const abort = () => timeoutController.abort();
	options?.signal?.addEventListener("abort", abort, { once: true });
	try {
		for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
			await (options?.assertUrl ?? assertPublicUrl)(current);
			const response = await (options?.fetchImpl ?? fetch)(current, {
				redirect: "manual",
				signal: timeoutController.signal,
				headers: {
					accept:
						"text/plain,text/markdown,text/html,application/json,application/xml;q=0.9,*/*;q=0.1",
					"user-agent": "pi-context-engine/0.1",
				},
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) throw new Error(`Redirect ${response.status} has no location`);
				if (redirect === MAX_REDIRECTS) {
					throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
				}
				current = new URL(location, current);
				continue;
			}
			if (!response.ok) {
				throw new Error(`Fetch failed with HTTP ${response.status}`);
			}
			const contentType = response.headers
				.get("content-type")
				?.split(";")[0]
				.trim()
				.toLocaleLowerCase() ?? "text/plain";
			if (!ALLOWED_CONTENT_TYPES.some((type) => contentType.startsWith(type))) {
				throw new Error(`Unsupported response content type: ${contentType}`);
			}
			const raw = await readBoundedBody(
				response,
				options?.maxBytes ?? DEFAULT_MAX_BYTES,
			);
			return {
				content:
					contentType === "text/html" ||
					contentType === "application/xhtml+xml"
						? decodeHtml(raw)
						: raw,
				finalUrl: current.toString(),
				contentType,
			};
		}
		throw new Error("unreachable redirect state");
	} finally {
		clearTimeout(timeout);
		options?.signal?.removeEventListener("abort", abort);
	}
}
