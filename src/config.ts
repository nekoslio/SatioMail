export interface Env {
	APP_PASSWORD: string;
	COOKIE_SECRET: string;
	EMAIL_USERNAME: string;
	EMAIL_PASSWORD: string;
	EMAIL_IMAP_HOST: string;
	EMAIL_IMAP_PORT: string;
	EMAIL_SMTP_HOST: string;
	EMAIL_SMTP_PORT: string;
	EMAIL_FROM?: string;
	ASSETS: Fetcher;
	/** 可选：用于跨实例登录限流的 KV 命名空间（不配置则退化为按隔离实例的内存计数） */
	LOGIN_KV?: KVNamespace;
	/** 可选：头像存储 KV（不配置则头像功能返回未配置提示） */
	AVATAR_KV?: KVNamespace;
	/** 可选：自动头像来源顺序，逗号分隔，取值 gravatar / qq；空或 none 表示关闭 */
	AVATAR_AUTO_SOURCE?: string;
	/** 可选：TOTP 二步验证密钥（Base32）。不配置则登录无需动态验证码 */
	TOTP_SECRET?: string;
	/** 可选：Turnstile 人机验证站点密钥（公开）。不配置则登录无人机验证 */
	TURNSTILE_SITE_KEY?: string;
	/** 可选：Turnstile 服务端校验密钥。与 SITE_KEY 成对配置才启用 */
	TURNSTILE_SECRET?: string;
}

export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_PORT = 465;

export function imapPort(env: Env): number {
	return parseInt(env.EMAIL_IMAP_PORT || "", 10) || DEFAULT_IMAP_PORT;
}

export function smtpPort(env: Env): number {
	return parseInt(env.EMAIL_SMTP_PORT || "", 10) || DEFAULT_SMTP_PORT;
}

export function fromAddress(env: Env): string {
	const from = env.EMAIL_FROM?.trim();
	if (from && from.length > 0) return from;
	return env.EMAIL_USERNAME;
}

export function accountEmail(env: Env): string {
	const m = fromAddress(env).match(/<([^>]+)>/);
	return m ? m[1] : fromAddress(env);
}
