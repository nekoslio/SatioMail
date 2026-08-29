import { CFImap, ImapError } from "cf-imap";
import type { Env } from "./config";
import { imapPort } from "./config";

const READ_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 20000;
const OVERALL_TIMEOUT_MS = 25000;

function makeImap(env: Env): CFImap {
	return new CFImap({
		host: env.EMAIL_IMAP_HOST,
		port: imapPort(env),
		tls: true,
		auth: {
			username: env.EMAIL_USERNAME,
			password: env.EMAIL_PASSWORD,
		},
		timeoutMs: READ_TIMEOUT_MS,
	});
}

function isConnectionError(e: unknown): boolean {
	return !(e instanceof ImapError);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label}超时（${Math.ceil(ms / 1000)}s）`)),
			Math.max(500, ms),
		);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * Closes the IMAP connection without blocking. logout() performs a full
 * LOGOUT round-trip which hangs (up to the read timeout) on a dead socket,
 * so we fire-and-forget and let the platform reclaim it.
 */
function closeQuietly(client: CFImap | null): void {
	if (!client) return;
	try {
		void client.logout().catch(() => {});
	} catch {
		// ignore
	}
}

/**
 * Runs an operation against a freshly-opened IMAP connection.
 *
 * The connection is deliberately NOT shared across requests: Cloudflare
 * Workers isolates are frozen/recycled between requests, which can leave a
 * long-lived TCP socket in a dead-but-hung state (reads neither deliver nor
 * error, so retries stack up timeouts and the request gets killed by the
 * platform). A fresh connection per request keeps every call bounded and
 * independent.
 */
export function withImap<T>(env: Env, fn: (imap: CFImap) => Promise<T>): Promise<T> {
	const deadline = Date.now() + OVERALL_TIMEOUT_MS;
	const remaining = () => Math.max(500, deadline - Date.now());

	const attempt = async (): Promise<T> => {
		const client = makeImap(env);
		await withTimeout(client.connect(), Math.min(CONNECT_TIMEOUT_MS, remaining()), "连接 IMAP 服务器");
		try {
			return await fn(client);
		} finally {
			closeQuietly(client);
		}
	};

	const run = () => withTimeout(attempt(), remaining(), "IMAP 操作");
	return run().catch((e) => {
		if (e instanceof ImapError) throw e;
		return run();
	});
}

export { ImapError };
