import type { Env } from "./config";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function cookieName(secure: boolean): string {
	// __Host- prefix: HTTPS 下绑定到 Secure + Path=/，防止会话固定/跨域注入
	return secure ? "__Host-cfqm_session" : "cfqm_session";
}

function isHttps(request: Request): boolean {
	return request.url.startsWith("https://");
}

interface SessionPayload {
	v: number;
	exp: number;
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const binary = String.fromCharCode(...bytes);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
	const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
}

export function constantTimeEqual(a: string, b: string): boolean {
	const ab = new TextEncoder().encode(a);
	const bb = new TextEncoder().encode(b);
	if (ab.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
	return diff === 0;
}

export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		if (key === name) return part.slice(idx + 1).trim();
	}
	return null;
}

export async function verifySession(request: Request, env: Env): Promise<boolean> {
	const token = readCookie(request, cookieName(isHttps(request)));
	if (!token) return false;
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	const [expB64, sigB64, payloadB64] = parts;
	if (!expB64 || !sigB64 || !payloadB64) return false;

	const exp = parseInt(new TextDecoder().decode(base64UrlDecode(expB64)), 10);
	if (isNaN(exp) || exp < Date.now() / 1000) return false;

	const expected = await hmac(env.COOKIE_SECRET, expB64 + "." + payloadB64);
	const expectedSig = base64UrlEncode(expected);
	if (!constantTimeEqual(sigB64, expectedSig)) return false;

	const payload = base64UrlDecode(payloadB64);
	try {
		const parsed = JSON.parse(new TextDecoder().decode(payload)) as SessionPayload;
		return parsed.v === 1 && parsed.exp === exp;
	} catch {
		return false;
	}
}

export async function createSession(env: Env): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	const expB64 = base64UrlEncode(new TextEncoder().encode(String(exp)));
	const payload: SessionPayload = { v: 1, exp };
	const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = await hmac(env.COOKIE_SECRET, expB64 + "." + payloadB64);
	const sigB64 = base64UrlEncode(sig);
	return `${expB64}.${sigB64}.${payloadB64}`;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
	const name = cookieName(secure);
	const flags = [
		`${name}=${token}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_TTL_SECONDS}`,
	];
	if (secure) flags.push("Secure");
	return flags.join("; ");
}

export function clearCookieHeader(secure: boolean): string {
	const name = cookieName(secure);
	const flags = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
	if (secure) flags.push("Secure");
	return flags.join("; ");
}

export function setSessionCookie(response: Response, token: string, secure: boolean): Response {
	response.headers.append("Set-Cookie", sessionCookieHeader(token, secure));
	return response;
}

export { isHttps };
