export interface Env {
	APP_PASSWORD: string;
	COOKIE_SECRET: string;
	// 旧版单账号配置：未配置 ACCOUNTS_CONFIG 时生效，向后兼容 1.2.0 及之前用户
	EMAIL_USERNAME?: string;
	EMAIL_PASSWORD?: string;
	EMAIL_IMAP_HOST?: string;
	EMAIL_IMAP_PORT?: string;
	EMAIL_SMTP_HOST?: string;
	EMAIL_SMTP_PORT?: string;
	EMAIL_FROM?: string;
	// 多账号配置（JSON 数组字符串）；推荐用 wrangler secret put ACCOUNTS_CONFIG 配置
	// 数组中每个账号包含 id / label / username / password / imapHost / imapPort /
	// smtpHost / smtpPort / from 可选；密码与授权码始终保存在 Secret，不下发给前端
	ACCOUNTS_CONFIG?: string;
	ASSETS: Fetcher;
	/** 可选：用于跨实例登录限流的 KV 命名空间（不配置则退化为按隔离实例的内存计数） */
	LOGIN_KV?: KVNamespace;
	/** 可选：头像存储 KV（不配置则头像功能返回未配置提示） */
	AVATAR_KV?: KVNamespace;
	/** 可选：TOTP 二步验证密钥（Base32）。不配置则登录无需动态验证码 */
	TOTP_SECRET?: string;
	/** 可选：Turnstile 人机验证站点密钥（公开）。不配置则登录无人机验证 */
	TURNSTILE_SITE_KEY?: string;
	/** 可选：Turnstile 服务端校验密钥。与 SITE_KEY 成对配置才启用 */
	TURNSTILE_SECRET?: string;
}

export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_PORT = 465;

export interface Account {
	id: string;
	label: string;
	username: string;
	password: string;
	imapHost: string;
	imapPort: number;
	smtpHost: string;
	smtpPort: number;
	from?: string;
}

/** 前端可见的账号视图：刻意排除密码、SMTP/IMAP 主机端口等敏感字段 */
export interface PublicAccount {
	id: string;
	label: string;
	email: string;
	from: string;
}

const LEGACY_ID = "default";

function sanitizeAccountLabel(raw: unknown, fallback: string): string {
	const text = String(raw ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 64);
	return text || fallback;
}

function sanitizeAccountId(raw: unknown): string {
	return String(raw ?? "").trim().slice(0, 64);
}

function parseAccount(input: unknown, index: number): Account | null {
	if (!input || typeof input !== "object") return null;
	const o = input as Record<string, unknown>;
	const username = String(o.username ?? o.email ?? "").trim();
	const password = String(o.password ?? "").trim();
	if (!username || !password) return null;
	const imapHost = String(o.imapHost ?? "").trim();
	const smtpHost = String(o.smtpHost ?? "").trim();
	if (!imapHost || !smtpHost) return null;
	const imapPort = parseInt(String(o.imapPort ?? ""), 10) || DEFAULT_IMAP_PORT;
	const smtpPort = parseInt(String(o.smtpPort ?? ""), 10) || DEFAULT_SMTP_PORT;
	const id = sanitizeAccountId(o.id) || `acc-${index + 1}`;
	const label = sanitizeAccountLabel(o.label, username);
	const fromRaw = typeof o.from === "string" ? o.from.trim() : "";
	const from = fromRaw || username;
	return { id, label, username, password, imapHost, imapPort, smtpHost, smtpPort, from };
}

/**
 * 把 ACCOUNTS_CONFIG 解析为账号数组；非法 JSON / 缺字段的条目会被跳过而非报错，
 * 单个坏数据不应让整份配置失效。解析失败时回退到空数组，调用方再退回到 legacy。
 */
function parseAccountsConfig(raw: string | undefined): Account[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error("ACCOUNTS_CONFIG is not valid JSON");
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Account[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const acc = parseAccount(parsed[i], i);
		if (acc) out.push(acc);
	}
	return out;
}

/** 账号去重：同 id 仅保留首次出现的实例，避免前端账号列表出现重复条目 */
function dedupeAccounts(accounts: Account[]): Account[] {
	const seen = new Set<string>();
	const result: Account[] = [];
	for (const acc of accounts) {
		if (seen.has(acc.id)) continue;
		seen.add(acc.id);
		result.push(acc);
	}
	return result;
}

function buildLegacyAccount(env: Env): Account | null {
	if (!env.EMAIL_USERNAME || !env.EMAIL_PASSWORD) return null;
	const imapHost = env.EMAIL_IMAP_HOST?.trim();
	const smtpHost = env.EMAIL_SMTP_HOST?.trim();
	if (!imapHost || !smtpHost) return null;
	const imapPort = parseInt(env.EMAIL_IMAP_PORT || "", 10) || DEFAULT_IMAP_PORT;
	const smtpPort = parseInt(env.EMAIL_SMTP_PORT || "", 10) || DEFAULT_SMTP_PORT;
	return {
		id: LEGACY_ID,
		label: env.EMAIL_USERNAME,
		username: env.EMAIL_USERNAME,
		password: env.EMAIL_PASSWORD,
		imapHost,
		imapPort,
		smtpHost,
		smtpPort,
		from: env.EMAIL_FROM?.trim() || env.EMAIL_USERNAME,
	};
}

/** 列出当前可用的全部账号：ACCOUNTS_CONFIG 优先，未配置时退回到单账号 legacy */
export function listAccounts(env: Env): Account[] {
	const configured = parseAccountsConfig(env.ACCOUNTS_CONFIG);
	if (configured.length > 0) return dedupeAccounts(configured);
	const legacy = buildLegacyAccount(env);
	return legacy ? [legacy] : [];
}

export function getActiveAccountId(env: Env): string {
	const accounts = listAccounts(env);
	if (accounts.length === 0) return LEGACY_ID;
	return accounts[0].id;
}

/**
 * 根据 id 解析账号。找不到时不抛错而是返回 null，由 API 层决定是否回退到首个账号
 * 或返回 400；这一策略保证会话里写错的 / 过期的 id 不会让整个请求 500。
 */
export function resolveAccount(env: Env, id: string | null | undefined): Account | null {
	const accounts = listAccounts(env);
	if (accounts.length === 0) return null;
	const want = (id ?? "").trim();
	if (want) {
		const hit = accounts.find((a) => a.id === want);
		if (hit) return hit;
	}
	return accounts[0];
}

export function toPublicAccount(acc: Account): PublicAccount {
	const m = (acc.from || acc.username).match(/<([^>]+)>/);
	return {
		id: acc.id,
		label: acc.label,
		email: m ? m[1].trim() : acc.username,
		from: acc.from || acc.username,
	};
}

export function fromAddressFor(acc: Account): string {
	return acc.from || acc.username;
}

export function accountEmailFor(acc: Account): string {
	const from = fromAddressFor(acc);
	const m = from.match(/<([^>]+)>/);
	return m ? m[1] : from;
}

export function smtpPortFor(acc: Account): number {
	return acc.smtpPort;
}

export function imapPortFor(acc: Account): number {
	return acc.imapPort;
}