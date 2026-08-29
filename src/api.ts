import type { CFImap, Email, Folder } from "cf-imap";
import { ImapError } from "./imap";
import type { Account, Env } from "./config";
import {
	fromAddressFor,
	accountEmailFor,
	smtpPortFor,
	imapPortFor,
	listAccounts,
	resolveAccount,
	toPublicAccount,
	getActiveAccountId,
} from "./config";
import { withImap } from "./imap";
import { sendMail } from "./smtp";
import { buildMimeMessage } from "./mime";
import { constantTimeEqual, createSession, setSessionCookie, clearCookieHeader, isHttps } from "./auth";
import { verifyTotp } from "./totp";

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// 邮件内容属于敏感数据，禁止浏览器/CDN 缓存
			"Cache-Control": "no-store",
		},
	});
}

export function error(message: string, status = 400): Response {
	return json({ ok: false, error: message }, status);
}

/**
 * 统一错误处理：把内部异常细节只打到服务端日志，返回给客户端的是脱敏后的
 * 通用信息，避免泄露 IMAP/SMTP 服务器内部状态、主机名等敏感信息。
 */
export function parseError(e: unknown, fallback = "操作失败"): Response {
	console.error("API error:", e instanceof Error ? e.stack || e.message : String(e));
	if (e instanceof ImapError) {
		return error("邮箱服务器操作失败，请稍后重试或检查邮箱配置", 500);
	}
	if (e instanceof Error) {
		if (/超时/.test(e.message)) return error("操作超时，请稍后重试", 504);
		return error("操作失败，请稍后重试", 500);
	}
	return error(fallback, 500);
}

type FolderKind =
	| "inbox"
	| "sent"
	| "drafts"
	| "trash"
	| "archive"
	| "spam"
	| "starred"
	| "other";

const KIND_RANK: Record<FolderKind, number> = {
	inbox: 0,
	starred: 1,
	sent: 2,
	drafts: 3,
	archive: 4,
	spam: 5,
	trash: 6,
	other: 7,
};

function folderAttrs(folder: Folder): string[] {
	return (folder.attributes || []).map((a) => a.replace(/^\\/, "").toLowerCase());
}

function isUsableFolder(folder: Folder): boolean {
	const attrs = folderAttrs(folder);
	return !attrs.includes("noselect") && !attrs.includes("nonexistent");
}

export function classifyFolder(folder: Folder): FolderKind {
	const name = folder.name.toLowerCase();
	const attrs = folderAttrs(folder);
	if (attrs.includes("inbox") || name === "inbox" || name === "收件箱") return "inbox";
	if (attrs.includes("sent") || name.includes("sent") || name === "已发送" || name === "发件箱") return "sent";
	if (attrs.includes("drafts") || name.includes("draft") || name === "草稿") return "drafts";
	if (
		attrs.includes("trash") ||
		attrs.includes("deleted") ||
		name.includes("trash") ||
		name.includes("deleted") ||
		name === "已删除"
	)
		return "trash";
	if (attrs.includes("archive") || name.includes("archive") || name === "归档") return "archive";
	if (
		attrs.includes("junk") ||
		attrs.includes("spam") ||
		name.includes("junk") ||
		name.includes("spam") ||
		name.includes("垃圾")
	)
		return "spam";
	if (attrs.includes("flagged") || name.includes("starred") || name.includes("星标")) return "starred";
	return "other";
}

export function specialFolderName(folders: Folder[], kind: FolderKind): string | null {
	let best: Folder | null = null;
	for (const f of folders) {
		if (!isUsableFolder(f)) continue;
		if (classifyFolder(f) === kind) {
			best = f;
			break;
		}
	}
	return best ? best.name : null;
}

interface AccountInfo {
	email: string;
	from: string;
	username: string;
	id: string;
	label: string;
}

export function accountInfo(acc: Account): AccountInfo {
	return {
		email: accountEmailFor(acc),
		from: fromAddressFor(acc),
		username: acc.username,
		id: acc.id,
		label: acc.label,
	};
}

async function listFolders(imap: CFImap): Promise<Folder[]> {
	let prefix = "";
	try {
		const { personal } = await imap.getNamespaces();
		prefix = personal[0]?.prefix ?? "";
	} catch {
		// NAMESPACE not supported; use the default namespace
	}
	return imap.getFolders(prefix, "*");
}

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;
// 登录限流：配置了 LOGIN_KV 时用 KV 实现跨实例全局限流，否则退化为按
// 隔离实例的内存计数（配合强密码足够个人使用）。
const loginAttempts = new Map<string, { count: number; resetAt: number }>;

function isLoginBlocked(ip: string): boolean {
	const now = Date.now();
	const e = loginAttempts.get(ip);
	return !!e && e.resetAt > now && e.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip: string): void {
	const now = Date.now();
	// 顺手清理过期项，避免 Map 随来源 IP 无限增长
	for (const [k, v] of loginAttempts) {
		if (v.resetAt <= now) loginAttempts.delete(k);
	}
	const e = loginAttempts.get(ip);
	if (!e || e.resetAt < now) {
		loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
	} else {
		e.count++;
	}
}

function clearLoginFailures(ip: string): void {
	loginAttempts.delete(ip);
}

async function loginBlocked(env: Env, ip: string): Promise<boolean> {
	if (!env.LOGIN_KV) return isLoginBlocked(ip);
	const key = `login:${ip}`;
	const now = Date.now();
	const raw = await env.LOGIN_KV.get(key);
	if (!raw) return false;
	const [ttlStr, countStr] = raw.split(":");
	if (parseInt(ttlStr, 10) <= now) return false;
	return parseInt(countStr, 10) >= LOGIN_MAX_ATTEMPTS;
}

async function recordLoginFailureKv(env: Env, ip: string): Promise<void> {
	if (!env.LOGIN_KV) {
		recordLoginFailure(ip);
		return;
	}
	const key = `login:${ip}`;
	const now = Date.now();
	const raw = await env.LOGIN_KV.get(key);
	let count = 0;
	if (raw) {
		const [ttlStr, countStr] = raw.split(":");
		if (parseInt(ttlStr, 10) > now) count = parseInt(countStr, 10);
	}
	await env.LOGIN_KV.put(key, `${now + LOGIN_WINDOW_MS}:${count + 1}`, { expirationTtl: 120 });
}

async function clearLoginFailuresKv(env: Env, ip: string): Promise<void> {
	if (!env.LOGIN_KV) {
		clearLoginFailures(ip);
		return;
	}
	await env.LOGIN_KV.delete(`login:${ip}`);
}

function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") || "unknown";
}

/* ---------------- IMAP 参数校验 ----------------
   folder/dest/flags/uids 均为客户端可控值，直接进入 IMAP 命令。
   这里拒绝可能破坏带引号字符串或注入命令序列的内容（引号、CR/LF），
   标记名走白名单归一化，uids 仅接受数字列表。 */
function assertSafeMailbox(name: string): Response | null {
	if (!name || name.length > 200) return error("邮箱文件夹名不合法", 400);
	if (/[\r\n"]/.test(name)) return error("邮箱文件夹名包含非法字符", 400);
	return null;
}

function safeUidList(uids: string | number[]): Response | string {
	const target = Array.isArray(uids) ? uids.join(",") : String(uids);
	if (!/^\d+(?:,\d+)*$/.test(target)) return error("uids 格式不正确", 400);
	return target;
}

const FLAG_ALIASES: Record<string, string> = {
	seen: "\\Seen",
	flagged: "\\Flagged",
	deleted: "\\Deleted",
	draft: "\\Draft",
	answered: "\\Answered",
};

function normalizeFlags(input: unknown[]): string[] {
	return (Array.isArray(input) ? input : [])
		.map((f) => FLAG_ALIASES[String(f).trim().replace(/^\\/, "").toLowerCase()] ?? null)
		.filter((f): f is string => f !== null);
}

/** 登录页配置（公开）：告知前端是否需要渲染动态验证码 / Turnstile */
export function handleAuthConfig(env: Env): Response {
	return json({
		ok: true,
		totpEnabled: Boolean(env.TOTP_SECRET),
		turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
	});
}

/** Turnstile 服务端校验（仅在配置了密钥时启用） */
async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
	if (!env.TURNSTILE_SECRET) return true; // 未启用则跳过
	if (!token) return false;
	try {
		const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip === "unknown" ? "" : ip }),
		});
		const result = (await res.json()) as { success: boolean };
		return result.success === true;
	} catch (e) {
		console.error("Turnstile verify failed:", e instanceof Error ? e.message : String(e));
		return false;
	}
}

export async function handleLogin(env: Env, body: { password?: string; totp?: string; turnstileToken?: string }, request: Request): Promise<Response> {
	if (!body.password) return error("缺少密码", 400);
	const ip = clientIp(request);
	if (await loginBlocked(env, ip)) {
		return error("尝试次数过多，请稍后再试", 429);
	}
	if (!(await verifyTurnstile(env, String(body.turnstileToken ?? ""), ip))) {
		return json({ ok: false, error: "人机验证未通过，请重试", needTurnstile: true }, 401);
	}
	if (!constantTimeEqual(body.password, env.APP_PASSWORD)) {
		await recordLoginFailureKv(env, ip);
		return json({ ok: false, error: "密码错误" }, 401);
	}
	if (env.TOTP_SECRET) {
		const totp = String(body.totp ?? "").trim();
		if (!totp) {
			return json({ ok: false, error: "请输入动态验证码", needTotp: true }, 401);
		}
		if (!(await verifyTotp(env.TOTP_SECRET, totp))) {
			await recordLoginFailureKv(env, ip);
			return json({ ok: false, error: "动态验证码错误或已过期", needTotp: true }, 401);
		}
	}
	await clearLoginFailuresKv(env, ip);
	const activeId = getActiveAccountId(env);
	const token = await createSession(env, activeId);
	const accounts = listAccounts(env);
	const active = accounts.find((a) => a.id === activeId) || accounts[0];
	const res = json({ ok: true, ...(active ? accountInfo(active) : { email: "", from: "", username: "", id: activeId, label: "" }) });
	setSessionCookie(res, token, isHttps(request));
	return res;
}

export async function handleLogout(request: Request): Promise<Response> {
	const res = json({ ok: true });
	res.headers.append("Set-Cookie", clearCookieHeader(isHttps(request)));
	return res;
}

export async function handleMe(env: Env, account: Account): Promise<Response> {
	return json({ ok: true, ...accountInfo(account) });
}

/* ---------------- 多账号管理 ----------------
   列表仅返回公开字段（id / label / email / from），密码与主机端口不暴露；
   写操作同样不返回敏感字段，避免无意间把凭据泄漏给前端。 */

export function handleListAccounts(env: Env, activeId: string): Response {
	const accounts = listAccounts(env);
	const resolved = resolveAccount(env, activeId);
	const currentId = resolved?.id ?? getActiveAccountId(env);
	return json({
		ok: true,
		active: currentId,
		accounts: accounts.map((a) => toPublicAccount(a)),
	});
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validateAccountId(id: unknown): string | null {
	const s = String(id ?? "").trim();
	if (!s || !ACCOUNT_ID_RE.test(s)) return null;
	return s;
}

/**
 * 切换活跃账号：生成新会话 Cookie，覆盖原会话。
 * 同源 POST + SameSite=Lax 已能挡掉 CSRF；这里再加同源校验作为纵深防御。
 */
export async function handleSetActiveAccount(env: Env, body: { id?: string }, request: Request): Promise<Response> {
	const id = validateAccountId(body.id);
	if (!id) return error("账号 id 不合法", 400);
	const accounts = listAccounts(env);
	if (!accounts.some((a) => a.id === id)) return error("账号不存在", 404);
	const token = await createSession(env, id);
	const acc = accounts.find((a) => a.id === id)!;
	const res = json({ ok: true, active: id, account: accountInfo(acc) });
	setSessionCookie(res, token, isHttps(request));
	return res;
}

/* ---------------- 头像（base64 存 KV，每账号独立槽位） ---------------- */

function avatarKvKey(accountId: string): string {
	// 旧版（1.2.x 及之前）使用裸 "avatar" 作为全局槽位；多账号版按账号 id 隔离，
	// 但当仅有一个 legacy 账号且键 "avatar" 已存在时仍可读，避免历史头像丢失。
	return `avatar:${accountId}`;
}

const LEGACY_AVATAR_KEY = "avatar";
const MAX_AVATAR_DATAURL = 400_000;
const AVATAR_MIME_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

async function readAvatar(env: Env, accountId: string): Promise<string | null> {
	if (!env.AVATAR_KV) return null;
	const direct = await env.AVATAR_KV.get(avatarKvKey(accountId));
	if (direct) return direct;
	const legacy = await env.AVATAR_KV.get(LEGACY_AVATAR_KEY);
	return legacy || null;
}

export async function handleAvatarGet(env: Env, account: Account): Promise<Response> {
	if (!env.AVATAR_KV) return json({ ok: true, dataUrl: null });
	const dataUrl = await readAvatar(env, account.id);
	return json({ ok: true, dataUrl: dataUrl || null });
}

export async function handleAvatarPut(
	env: Env,
	account: Account,
	body: { dataUrl?: string; clear?: boolean },
): Promise<Response> {
	if (!env.AVATAR_KV) {
		return error("头像存储未配置：请在 wrangler.toml 中启用 AVATAR_KV 并重新部署", 501);
	}
	if (body.clear) {
		await env.AVATAR_KV.delete(avatarKvKey(account.id));
		return json({ ok: true });
	}
	const dataUrl = body.dataUrl || "";
	if (!AVATAR_MIME_RE.test(dataUrl)) {
		return error("仅支持 PNG / JPEG / WebP / GIF 图片", 400);
	}
	if (dataUrl.length > MAX_AVATAR_DATAURL) {
		return error("图片过大，请使用 256KB 以内的图片", 400);
	}
	await env.AVATAR_KV.put(avatarKvKey(account.id), dataUrl);
	return json({ ok: true });
}

export async function handleFolders(env: Env, account: Account): Promise<Response> {
	return withImap(account, async (imap) => {
		const folders = await listFolders(imap);

		const results = [];
		for (const folder of folders) {
			if (!isUsableFolder(folder)) continue;
			let status: Record<string, number> = {};
			try {
				status = await imap.status(folder.name);
			} catch {
				// some folders don't support STATUS; skip counts
			}
			results.push({
				name: folder.name,
				delimiter: folder.delimiter,
				attributes: folder.attributes,
				kind: classifyFolder(folder),
				messages: status.messages ?? 0,
				unread: status.unseen ?? 0,
			});
		}

		results.sort((a, b) => {
			const r = KIND_RANK[a.kind] - KIND_RANK[b.kind];
			if (r !== 0) return r;
			return a.name.localeCompare(b.name);
		});

		return json({ ok: true, folders: results });
	}).catch((e) => parseError(e));
}

function hasAttachments(email: Email): boolean {
	const ct = (email.headers?.["content-type"] ?? email.contentType ?? "").toLowerCase();
	return ct.includes("multipart/mixed") || ct.includes("multipart/related");
}

function toListItem(email: Email) {
	return {
		uid: email.uid,
		seq: email.seq,
		flags: email.flags,
		internalDate: email.internalDate instanceof Date ? email.internalDate.toISOString() : email.internalDate,
		size: email.size,
		from: email.from,
		to: email.to,
		cc: email.cc,
		subject: email.subject,
		messageID: email.messageID,
		hasAttachments: hasAttachments(email),
		read: email.flags.includes("Seen"),
		flagged: email.flags.includes("Flagged"),
	};
}

export async function handleListEmails(env: Env, account: Account, url: URL): Promise<Response> {
	const folder = url.searchParams.get("folder") || "INBOX";
	const bad = assertSafeMailbox(folder);
	if (bad) return bad;
	const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
	const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));

	return withImap(account, async (imap) => {
		await imap.selectFolder(folder);
		const seqs = await imap.searchEmails({ all: true });
		const total = seqs.length;
		seqs.reverse();
		const page = seqs.slice(offset, offset + limit);
		if (page.length === 0) return json({ ok: true, items: [], total, offset, limit });
		const start = page[page.length - 1];
		const end = page[0];
		const emails = await imap.fetchEmails({ limit: [start, end], fetchBody: false, peek: true });
		const bySeq = new Map(emails.map((e) => [e.seq, e]));
		const items = page
			.map((seq) => bySeq.get(seq))
			.filter((e): e is Email => Boolean(e))
			.map(toListItem);
		return json({ ok: true, items, total, offset, limit });
	}).catch((e) => parseError(e));
}

const SEARCH_LIMIT = 500;

function matchesQuery(email: Email, q: string): boolean {
	const haystack = [
		email.subject ?? "",
		...(email.from ?? []),
		...(email.to ?? []),
		...(email.cc ?? []),
		email.messageID ?? "",
		email.headers?.["reply-to"] ?? "",
	]
		.join(" ")
		.toLowerCase();
	return haystack.includes(q);
}

/**
 * Tencent QQMail / 163 等企业邮服务器的 IMAP SEARCH 实现不完整——`TEXT` /
 * `SUBJECT` / `FROM` / `HEADER` 等条件都会被忽略并返回整个邮箱，因此这里改为
 * 拉取最近一批邮件头部后在本地按关键词过滤。
 */
export async function handleSearchEmails(env: Env, account: Account, url: URL): Promise<Response> {
	const folder = url.searchParams.get("folder") || "INBOX";
	const bad = assertSafeMailbox(folder);
	if (bad) return bad;
	const q = (url.searchParams.get("q") || "").trim().toLowerCase();
	if (!q) return error("缺少搜索关键词", 400);

	return withImap(account, async (imap) => {
		await imap.selectFolder(folder);
		const seqs = await imap.searchEmails({ all: true });
		seqs.reverse();
		const page = seqs.slice(0, SEARCH_LIMIT);
		if (page.length === 0) return json({ ok: true, items: [], total: 0, folder });
		const start = page[page.length - 1];
		const end = page[0];
		const emails = await imap.fetchEmails({ limit: [start, end], fetchBody: false, peek: true });
		const wanted = new Set(page);
		const items = emails
			.filter((e) => wanted.has(e.seq))
			.filter((e) => matchesQuery(e, q))
			.map(toListItem);
		return json({ ok: true, items, total: items.length, folder, limited: seqs.length > SEARCH_LIMIT });
	}).catch((e) => parseError(e));
}

export async function handleReadEmail(env: Env, account: Account, url: URL): Promise<Response> {
	const folder = url.searchParams.get("folder") || "INBOX";
	const bad = assertSafeMailbox(folder);
	if (bad) return bad;
	const uid = parseInt(url.searchParams.get("uid") || "0", 10);
	const markRead = url.searchParams.get("read") !== "0";
	if (!uid) return error("缺少 uid", 400);

	return withImap(account, async (imap) => {
		const emails = await imap.fetchEmails({
			folder,
			limit: [uid, uid],
			useUid: true,
			fetchBody: true,
			peek: !markRead,
		});
		const email = emails[0];
		if (!email) return error("邮件不存在", 404);
		const attachment = (a: Email["attachments"][number]) => ({
			filename: a.filename,
			mimeType: a.mimeType,
			size: a.size,
			encoding: a.encoding,
			contentBase64: a.contentBase64,
			contentId: a.contentId ?? null,
			isInline: a.isInline,
		});
		return json({
			ok: true,
			email: {
				uid: email.uid,
				seq: email.seq,
				flags: email.flags,
				internalDate: email.internalDate instanceof Date ? email.internalDate.toISOString() : email.internalDate,
				size: email.size,
				from: email.from,
				to: email.to,
				cc: email.cc,
				subject: email.subject,
				messageID: email.messageID,
				inReplyTo: email.headers?.["in-reply-to"] ?? null,
				references: email.headers?.["references"] ?? null,
				bodyText: email.body.text ?? null,
				bodyHtml: email.body.html ?? null,
				attachments: email.attachments.map(attachment),
				read: email.flags.includes("Seen"),
			},
		});
	}).catch((e) => parseError(e));
}

interface FlagActionBody {
	folder?: string;
	uids: string | number[];
	flags: string[];
	action?: "add" | "remove" | "replace";
}

export async function handleSetFlags(env: Env, account: Account, body: FlagActionBody): Promise<Response> {
	const folder = body.folder || "INBOX";
	const bad = assertSafeMailbox(folder);
	if (bad) return bad;
	if (!body.uids) return error("缺少 uids", 400);
	const targetOrErr = safeUidList(body.uids);
	if (typeof targetOrErr === "object") return targetOrErr;
	const target = targetOrErr;
	const flags = normalizeFlags(body.flags);
	if (flags.length === 0) return error("缺少有效邮件标记", 400);
	const action = body.action ?? "add";

	return withImap(account, async (imap) => {
		await imap.selectFolder(folder);
		await imap.storeFlags(target, flags, action, true);
		return json({ ok: true });
	}).catch((e) => parseError(e));
}

interface MoveBody {
	folder?: string;
	uids: string | number[];
	dest: string;
}

function hasCapability(imap: CFImap, name: string): boolean {
	return (imap.capabilities || []).some((c) => c.toUpperCase() === name.toUpperCase());
}

/**
 * Moves messages using UID MOVE when the server supports it, otherwise falls
 * back to COPY + STORE \Deleted + EXPUNGE (RFC 6851 §5).
 */
async function moveWithFallback(imap: CFImap, dest: string, target: string, useUid: boolean) {
	if (hasCapability(imap, "MOVE")) {
		return imap.move(dest, target, useUid);
	}
	await imap.copy(dest, target, useUid);
	await imap.storeFlags(target, ["Deleted"], "add", useUid);
	await imap.expunge({ useUid, range: target });
	return null;
}

export async function handleMove(env: Env, account: Account, body: MoveBody): Promise<Response> {
	const folder = body.folder || "INBOX";
	const bad = assertSafeMailbox(folder);
	if (bad) return bad;
	if (!body.uids || !body.dest) return error("缺少参数", 400);
	const badDest = assertSafeMailbox(body.dest);
	if (badDest) return badDest;
	const targetOrErr = safeUidList(body.uids);
	if (typeof targetOrErr === "object") return targetOrErr;
	const target = targetOrErr;

	return withImap(account, async (imap) => {
		await imap.selectFolder(folder);
		await moveWithFallback(imap, body.dest, target, true);
		return json({ ok: true });
	}).catch((e) => parseError(e));
}

interface DeleteBody {
	folder?: string;
	uids: string | number[];
	permanent?: boolean;
}

export async function handleDelete(env: Env, account: Account, body: DeleteBody): Promise<Response> {
	const folder = body.folder || "INBOX";
	const bad = assertSafeMailbox(folder);
	if (bad) return bad;
	if (!body.uids) return error("缺少 uids", 400);
	const targetOrErr = safeUidList(body.uids);
	if (typeof targetOrErr === "object") return targetOrErr;
	const target = targetOrErr;

	return withImap(account, async (imap) => {
		await imap.selectFolder(folder);
		const folders = await listFolders(imap);
		const trash = specialFolderName(folders, "trash");

		const toTrash = !body.permanent && trash && trash !== folder;
		if (toTrash) {
			await moveWithFallback(imap, trash, target, true);
		} else {
			await imap.storeFlags(target, ["Deleted"], "add", true);
			await imap.expunge({ useUid: true, range: target });
		}
		return json({ ok: true });
	}).catch((e) => parseError(e));
}

interface SendBody {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	text?: string;
	html?: string;
	attachments?: Array<{ filename: string; contentType: string; dataBase64: string }>;
	inReplyTo?: string;
	references?: string;
}

/* ---------------- 发送路径服务端校验 ----------------
   客户端输入在到达 SMTP/MIME 层前统一过这道闸：地址格式、CRLF 剥除、
   收件人数量与附件限额。防止信头/信封注入把认证账号变成发信中继。 */
const EMAIL_RE = /^[^\s<>"@,;:\\]+@[^\s<>"@,;:\\]+\.[A-Za-z]{2,}$/;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const stripCrlf = (value: string): string => value.replace(/[\r\n]+/g, " ");

function isEmail(addr: string): boolean {
	return EMAIL_RE.test(addr);
}

function base64Bytes(b64: string): number {
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export async function handleSend(env: Env, account: Account, body: SendBody): Promise<Response> {
	const to = (Array.isArray(body.to) ? body.to : [])
		.map((s) => stripCrlf(String(s ?? "").trim()))
		.filter(Boolean);
	const cc = (body.cc ?? []).map((s) => stripCrlf(String(s ?? "").trim())).filter(Boolean);
	const bcc = (body.bcc ?? []).map((s) => stripCrlf(String(s ?? "").trim())).filter(Boolean);
	if (to.length === 0) return error("收件人不能为空", 400);
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
		return error(`收件人总数不能超过 ${MAX_RECIPIENTS}`, 400);
	}
	for (const addr of [...to, ...cc, ...bcc]) {
		if (!isEmail(addr)) return error(`收件人地址格式不正确：${addr}`, 400);
	}

	const subject = stripCrlf(String(body.subject ?? "")).slice(0, 500);
	const html = typeof body.html === "string" ? body.html : "";
	const text = typeof body.text === "string" ? body.text : "";

	const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, MAX_ATTACHMENTS);
	let totalBytes = 0;
	for (const att of attachments) {
		if (!att || typeof att.dataBase64 !== "string") return error("附件数据不合法", 400);
		const bytes = base64Bytes(att.dataBase64);
		if (bytes > MAX_ATTACHMENT_BYTES) return error("单个附件超过 25MB 限制", 400);
		totalBytes += bytes;
		if (/[\r\n"]/.test(String(att.filename ?? ""))) {
			return error("附件名包含非法字符", 400);
		}
	}
	if (totalBytes > MAX_ATTACHMENT_BYTES) return error("附件总大小超过 25MB 限制", 400);

	const inReplyTo = body.inReplyTo ? stripCrlf(String(body.inReplyTo)) : undefined;
	const references = body.references ? stripCrlf(String(body.references)) : undefined;

	const from = fromAddressFor(account);

	const raw = buildMimeMessage({
		from,
		to,
		cc,
		subject,
		html,
		text,
		attachments,
		inReplyTo,
		references,
	});

	try {
		await sendMail(account.smtpHost, smtpPortFor(account), account.username, account.password, {
			from,
			to,
			cc,
			bcc,
			subject,
			rawMessage: raw,
		});
	} catch (e) {
		console.error("SMTP send failed", account.id, e instanceof Error ? e.message : String(e));
		return error("邮件发送失败，请检查收件人地址后重试", 502);
	}

	// Best-effort: save a copy to the Sent folder so the client shows it.
	try {
		await withImap(account, async (imap) => {
			const folders = await listFolders(imap);
			const sent = specialFolderName(folders, "sent");
			if (sent) {
				await imap.append(sent, raw, ["Seen"]);
			}
		});
	} catch (e) {
		console.error("Failed to save to Sent folder", account.id, e);
	}

	return json({ ok: true });
}