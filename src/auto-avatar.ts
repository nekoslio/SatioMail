/**
 * 自动头像来源：Gravatar 与 QQ 头像。
 *
 * 两个来源都是公开服务，不需要鉴权；服务端 fetch 后转成 data URL，
 * 再写入现有 AVATAR_KV 的自动槽位。前端在 /api/avatar 拿到 null 时
 * 调一次 /api/avatar/auto 触发查找，结果会被缓存住。
 *
 * 默认按 env.AVATAR_AUTO_SOURCE（逗号分隔）顺序尝试：
 *   "gravatar,qq"  默认：先 Gravatar 后 QQ
 *   "qq"           只用 QQ
 *   "none" / ""    关闭
 */

import type { Env } from "./config";

const AUTO_CACHE_PREFIX = "auto-avatar:";
const AUTO_NEGATIVE_TTL = 60 * 60 * 24 * 7; // 未命中也缓存 7 天，避免每次都打外网
const AUTO_POSITIVE_TTL = 60 * 60 * 24 * 30; // 命中缓存 30 天
const AUTO_FETCH_TIMEOUT_MS = 5000;
const AUTO_MAX_BYTES = 256 * 1024;

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

export interface AutoAvatarConfig {
	sources: string[]; // 已规范化的来源数组，按顺序尝试
}

export function parseAutoAvatarConfig(raw: string | undefined): AutoAvatarConfig {
	// 未配置时默认开启（gravatar,qq）；显式留空或 "none" 表示关闭
	if (raw === undefined) return { sources: ["gravatar", "qq"] };
	const cleaned = raw
		.split(/[,\s]+/)
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s === "gravatar" || s === "qq");
	if (cleaned.length === 0) return { sources: [] };
	return { sources: cleaned };
}

function normalizeEmail(email: string): string {
	// accountEmailFor 已保证返回不含显示名的纯邮箱地址
	return email.trim().toLowerCase();
}

/**
 * Gravatar 用 MD5(lowercase(email))，由 en.gravatar.com 公开返回 404 / 默认头像。
 * 用 fetch 抓头像、404 即视为未命中，不抛错。
 */
async function lookupGravatar(email: string, signal: AbortSignal): Promise<string | null> {
	const hashHex = await md5Hex(email);
	const url = `https://www.gravatar.com/avatar/${hashHex}?d=404&s=160`;
	const res = await fetch(url, { signal, redirect: "follow" });
	if (res.status === 404) return null;
	if (!res.ok) return null;
	const mime = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
	if (!ALLOWED_MIME.has(mime)) return null;
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength === 0 || buf.byteLength > AUTO_MAX_BYTES) return null;
	return `data:${mime};base64,${bytesToBase64(buf)}`;
}

/**
 * QQ 头像：地址为腾讯系域名（qq.com / vip.qq.com / foxmail.com）且
 * 本地段是 5–12 位纯数字时，按 QQ 号查 q.qlogo.cn；
 * 其他情况下直接放弃（与 Gravatar 的回退互补，避免对任意邮箱乱猜 QQ 号）。
 */
async function lookupQq(email: string, signal: AbortSignal): Promise<string | null> {
	const at = email.lastIndexOf("@");
	if (at <= 0) return null;
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	if (domain !== "qq.com" && domain !== "vip.qq.com" && domain !== "foxmail.com") return null;
	if (!/^\d{5,12}$/.test(local)) return null;
	const url = `https://q.qlogo.cn/g?b=qq&nk=${encodeURIComponent(local)}&s=160`;
	const res = await fetch(url, { signal, redirect: "follow" });
	if (!res.ok) return null;
	const mime = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
	if (!ALLOWED_MIME.has(mime)) return null;
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength === 0 || buf.byteLength > AUTO_MAX_BYTES) return null;
	return `data:${mime};base64,${bytesToBase64(buf)}`;
}

type Fetcher = (email: string, signal: AbortSignal) => Promise<string | null>;

const SOURCE_FETCHERS: Record<string, Fetcher> = {
	gravatar: lookupGravatar,
	qq: lookupQq,
};

export interface AutoAvatarResult {
	source: string | null;
	dataUrl: string | null;
}

/**
 * 串行尝试配置的来源；命中即停。KV 缓存层由调用方处理。
 * 调用方应传入 ctx.waitUntil 让缓存写操作脱离主请求生命周期。
 */
export async function resolveAutoAvatar(cfg: AutoAvatarConfig, email: string): Promise<AutoAvatarResult> {
	const normalized = normalizeEmail(email);
	if (!normalized || !normalized.includes("@")) return { source: null, dataUrl: null };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AUTO_FETCH_TIMEOUT_MS);
	try {
		for (const source of cfg.sources) {
			const fetcher = SOURCE_FETCHERS[source];
			if (!fetcher) continue;
			try {
				const dataUrl = await fetcher(normalized, controller.signal);
				if (dataUrl) return { source, dataUrl };
			} catch (e) {
				if ((e as Error)?.name === "AbortError") break;
				// 单个来源失败不影响后续来源
			}
		}
		return { source: null, dataUrl: null };
	} finally {
		clearTimeout(timer);
	}
}

function autoKvKey(accountId: string): string {
	// 按账号隔离，多账号部署互不串用；id 是账号配置里的稳定标识，不含邮箱明文
	return `${AUTO_CACHE_PREFIX}${accountId}`;
}

export async function readAutoAvatarCache(env: Env, accountId: string): Promise<AutoAvatarResult | null> {
	if (!env.AVATAR_KV) return null;
	const raw = await env.AVATAR_KV.get(autoKvKey(accountId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as AutoAvatarResult;
		return parsed;
	} catch {
		return null;
	}
}

export async function writeAutoAvatarCache(
	env: Env,
	accountId: string,
	result: AutoAvatarResult,
): Promise<void> {
	if (!env.AVATAR_KV) return;
	const ttl = result.dataUrl ? AUTO_POSITIVE_TTL : AUTO_NEGATIVE_TTL;
	await env.AVATAR_KV.put(autoKvKey(accountId), JSON.stringify(result), { expirationTtl: ttl });
}

/* ---------------- MD5 / Base64 ----------------
   Cloudflare Workers 没有内置 MD5；Gravatar 要求的是 RFC 1321 MD5，
   这里用纯 JS 位运算实现，输出经 RFC 1321 测试向量验证。*/

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function md5Hex(input: string): Promise<string> {
	return new Promise((resolve) => {
		// 这里用同步的轮转实现，封装成 Promise 便于和签名风格统一。
		resolve(syncMd5Hex(input));
	});
}

function syncMd5Hex(input: string): string {
	// RFC 1321
	const bytes = new TextEncoder().encode(input);
	const len = bytes.length;
	const bitLen = len * 8;

	// 预填幻数（little-endian）
	const a0 = 0x67452301;
	const b0 = 0xefcdab89;
	const c0 = 0x98badcfe;
	const d0 = 0x10325476;

	const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
	padded.set(bytes);
	padded[len] = 0x80;

	const view = new DataView(padded.buffer);
	// 64-bit 长度按 little-endian 写入
	const low = bitLen >>> 0;
	const high = Math.floor(bitLen / 0x100000000) >>> 0;
	view.setUint32(padded.length - 8, low, true);
	view.setUint32(padded.length - 4, high, true);

	const K = new Int32Array([
		0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
		0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
		0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
		0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
		0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
		0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
		0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
		0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
		0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
		0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
		0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
	]);

	const S = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
	];

	let A = a0 | 0;
	let B = b0 | 0;
	let C = c0 | 0;
	let D = d0 | 0;

	const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

	for (let i = 0; i < padded.length; i += 64) {
		const M = new Int32Array(16);
		for (let j = 0; j < 16; j++) {
			M[j] = view.getInt32(i + j * 4, true);
		}
		const a = A, b = B, c = C, d = D; // 块初值，块结束后回加
		for (let j = 0; j < 64; j++) {
			let F: number, g: number;
			// F 必须用滚动中的 B/C/D 计算，不能引用块初值 b/c/d
			if (j < 16) {
				F = (B & C) | (~B & D);
				g = j;
			} else if (j < 32) {
				F = (D & B) | (~D & C);
				g = (5 * j + 1) % 16;
			} else if (j < 48) {
				F = B ^ C ^ D;
				g = (3 * j + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * j) % 16;
			}
			const temp = D;
			D = C;
			C = B;
			B = (B + rotl((A + F + (K[j] | 0) + (M[g] | 0)) | 0, S[j])) | 0;
			A = temp;
		}
		A = (A + a) | 0;
		B = (B + b) | 0;
		C = (C + c) | 0;
		D = (D + d) | 0;
	}

	// MD5 摘要按小端字节序输出每个 32 位字（RFC 1321 Encode），即先打低位字节
	const toHex = (n: number) => {
		let out = "";
		for (let k = 0; k < 4; k++) {
			out += ((n >>> (k * 8)) & 0xff).toString(16).padStart(2, "0");
		}
		return out;
	};
	return toHex(A) + toHex(B) + toHex(C) + toHex(D);
}
