/**
 * RFC 6238 TOTP 验证（SHA-1 / 6 位 / 30 秒，兼容主流验证器 App）。
 * 密钥为 Base32（RFC 4648）编码，即验证器 App 手动输入时使用的格式。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

export function base32Decode(input: string): Uint8Array {
	const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx === -1) continue;
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

/** 常量时间字符串比较（长度不等立即返回 false，属可接受的信息量） */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

async function totpAt(key: Uint8Array, counter: number): Promise<string> {
	const counterBuf = new ArrayBuffer(8);
	const view = new DataView(counterBuf);
	view.setUint32(0, Math.floor(counter / 2 ** 32));
	view.setUint32(4, counter >>> 0);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as unknown as BufferSource,
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBuf));
	const offset = sig[sig.length - 1] & 0x0f;
	const bin =
		((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
	return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * 校验 6 位动态码，容忍 ±1 个时间窗（约 ±30 秒时钟偏差）。
 * @param secretBase32 Base32 密钥（验证器 App 里的那串）
 * @param code        用户输入的 6 位动态码
 */
export async function verifyTotp(secretBase32: string, code: string, window = 1): Promise<boolean> {
	const clean = code.replace(/\s/g, "");
	if (!/^\d{6}$/.test(clean)) return false;
	const key = base32Decode(secretBase32);
	if (key.length < 10) return false;
	const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
	for (let drift = -window; drift <= window; drift++) {
		const expected = await totpAt(key, counter + drift);
		if (constantTimeEqual(expected, clean)) return true;
	}
	return false;
}
