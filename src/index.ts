import type { Env } from "./config";
import { verifySession } from "./auth";
import {
	json,
	error,
	handleLogin,
	handleLogout,
	handleMe,
	handleAuthConfig,
	handleAvatarGet,
	handleAvatarPut,
	handleFolders,
	handleListEmails,
	handleSearchEmails,
	handleReadEmail,
	handleSetFlags,
	handleMove,
	handleDelete,
	handleSend,
} from "./api";

async function readJson<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		return {} as T;
	}
}

/**
 * CSRF 防御（纵深防御）：SameSite=Lax 已阻止跨站 POST 携带 Cookie，
 * 这里再校验浏览器上报的 Sec-Fetch-Site / Origin，跨站请求一律拒绝。
 * curl 等非浏览器客户端不发送这些头，予以放行。
 */
function isSameOrigin(request: Request): boolean {
	const site = request.headers.get("Sec-Fetch-Site");
	if (site) {
		return site === "same-origin" || site === "none";
	}
	const origin = request.headers.get("Origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
		"Content-Security-Policy": [
			"default-src 'self'",
			"script-src 'self' https://challenges.cloudflare.com",
			// 'unsafe-inline'：前端通过 style 属性内联头像背景色等动态样式，属已知取舍
			"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
			"font-src https://fonts.gstatic.com data:",
			"img-src 'self' data: https:",
			"connect-src 'self'",
			"frame-src https://challenges.cloudflare.com",
			"object-src 'none'",
			"base-uri 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join("; "),
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function applySecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname;

	if (request.method === "POST" && path === "/api/login") {
		return handleLogin(env, await readJson(request), request);
	}

	// 登录页配置必须公开：登录页需要它来决定是否渲染动态码/Turnstile
	if (request.method === "GET" && path === "/api/config") {
		return handleAuthConfig(env);
	}

	if (!(await verifySession(request, env))) {
		return error("未登录或会话已过期", 401);
	}

	if (request.method === "POST" && path === "/api/logout") {
		return handleLogout(request);
	}

	if (request.method === "GET" && path === "/api/me") {
		return handleMe(env);
	}

	if (request.method === "GET" && path === "/api/avatar") {
		return handleAvatarGet(env);
	}

	if (request.method === "POST" && path === "/api/avatar") {
		if (!isSameOrigin(request)) return error("拒绝跨站请求", 403);
		return handleAvatarPut(env, await readJson(request));
	}

	if (request.method === "GET" && path === "/api/folders") {
		return handleFolders(env);
	}

	if (request.method === "GET" && path === "/api/emails") {
		return handleListEmails(env, url);
	}

	if (request.method === "GET" && path === "/api/search") {
		return handleSearchEmails(env, url);
	}

	if (request.method === "GET" && path === "/api/email") {
		return handleReadEmail(env, url);
	}

	if (request.method === "POST" && path === "/api/flags") {
		if (!isSameOrigin(request)) return error("拒绝跨站请求", 403);
		return handleSetFlags(env, await readJson(request));
	}

	if (request.method === "POST" && path === "/api/move") {
		if (!isSameOrigin(request)) return error("拒绝跨站请求", 403);
		return handleMove(env, await readJson(request));
	}

	if (request.method === "POST" && path === "/api/delete") {
		if (!isSameOrigin(request)) return error("拒绝跨站请求", 403);
		return handleDelete(env, await readJson(request));
	}

	if (request.method === "POST" && path === "/api/send") {
		if (!isSameOrigin(request)) return error("拒绝跨站请求", 403);
		return handleSend(env, await readJson(request));
	}

	return error("接口不存在", 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// 静态资源由 ASSETS 直接返回（安全响应头通过 public/_headers 由边缘附加，
		// 不在此处重新包装响应体，避免流式响应被打断）。
		if (!url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		return applySecurityHeaders(await handleApi(request, env, url));
	},
} satisfies ExportedHandler<Env>;
