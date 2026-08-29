import { connect } from "cloudflare:sockets";

export class SmtpError extends Error {
	code: number;
	constructor(message: string, code = 0) {
		super(message);
		this.name = "SmtpError";
		this.code = code;
	}
}

interface SmtpReply {
	code: number;
	lines: string[];
}

function utf8ToBase64(str: string): string {
	const bytes = new TextEncoder().encode(str);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * 从 "Name <a@b.c>" 或裸 "a@b.c" 中提取信封用的裸邮箱地址。
 * SMTP 的 MAIL FROM / RCPT TO 只接受裸地址，带显示名会被服务器拒绝。
 * 最后防线：剥除 CR/LF，防止把用户输入拼进 SMTP 会话时注入额外命令。
 */
export function extractEmail(addr: string): string {
	const m = addr.match(/<([^<>]+)>/);
	const raw = m ? m[1].trim() : addr.trim();
	return raw.replace(/[\r\n]+/g, "");
}

export class SmtpClient {
	private socket: Socket | null = null;
	private reader: ReadableStreamDefaultReader<string> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private buffer = "";

	constructor(
		private hostname: string,
		private port: number,
	) {}

	private async readLine(): Promise<string> {
		if (this.reader === null) throw new SmtpError("Not connected");
		while (true) {
			const idx = this.buffer.indexOf("\r\n");
			if (idx >= 0) {
				const line = this.buffer.slice(0, idx);
				this.buffer = this.buffer.slice(idx + 2);
				return line;
			}
			const { value, done } = await this.reader.read();
			if (done) throw new SmtpError("SMTP connection closed by server");
			this.buffer += value;
		}
	}

	private async readReply(): Promise<SmtpReply> {
		const lines: string[] = [];
		let first = await this.readLine();
		const code = parseInt(first.slice(0, 3), 10);
		lines.push(first);
		while (first.length >= 4 && first[3] === "-") {
			first = await this.readLine();
			lines.push(first);
		}
		return { code, lines };
	}

	private async send(line: string): Promise<void> {
		if (this.writer === null) throw new SmtpError("Not connected");
		await this.writer.write(new TextEncoder().encode(line + "\r\n"));
	}

	private async expect(code: number): Promise<SmtpReply> {
		const reply = await this.readReply();
		if (reply.code !== code) {
			throw new SmtpError(
				`SMTP expected ${code}, got ${reply.code}: ${reply.lines.join(" | ")}`,
				reply.code,
			);
		}
		return reply;
	}

	async connect(): Promise<void> {
		this.socket = connect(
			{ hostname: this.hostname, port: this.port },
			{ secureTransport: "on", allowHalfOpen: false },
		);
		this.reader = this.socket.readable.pipeThrough(new TextDecoderStream()).getReader();
		this.writer = this.socket.writable.getWriter();
		const greeting = await this.readReply();
		if (greeting.code !== 220) {
			throw new SmtpError(
				`SMTP greeting failed (${greeting.code}): ${greeting.lines.join(" | ")}`,
				greeting.code,
			);
		}
	}

	async ehlo(): Promise<void> {
		await this.send("EHLO cfquickmail");
		await this.expect(250);
	}

	async authLogin(username: string, password: string): Promise<void> {
		await this.send("AUTH LOGIN");
		const r1 = await this.readReply();
		if (r1.code !== 334) {
			throw new SmtpError(`SMTP AUTH LOGIN rejected (${r1.code}): ${r1.lines.join(" | ")}`, r1.code);
		}
		await this.send(utf8ToBase64(username));
		const r2 = await this.readReply();
		if (r2.code !== 334) {
			throw new SmtpError(`SMTP AUTH LOGIN rejected (${r2.code}): ${r2.lines.join(" | ")}`, r2.code);
		}
		await this.send(utf8ToBase64(password));
		const r3 = await this.readReply();
		if (r3.code !== 235) {
			throw new SmtpError(`SMTP authentication failed (${r3.code}): ${r3.lines.join(" | ")}`, r3.code);
		}
	}

	async mailFrom(from: string): Promise<void> {
		await this.send(`MAIL FROM:<${extractEmail(from)}>`);
		await this.expect(250);
	}

	async rcptTo(recipients: string[]): Promise<void> {
		for (const rcpt of recipients) {
			await this.send(`RCPT TO:<${extractEmail(rcpt)}>`);
			await this.expect(250);
		}
	}

	async data(message: string): Promise<void> {
		await this.send("DATA");
		await this.expect(354);
		if (this.writer === null) throw new SmtpError("Not connected");
		const stuffed = message.replace(/^\./gm, "..");
		await this.writer.write(new TextEncoder().encode(stuffed));
		await this.writer.write(new TextEncoder().encode("\r\n.\r\n"));
		await this.expect(250);
	}

	async quit(): Promise<void> {
		try {
			if (this.writer) await this.send("QUIT");
			if (this.reader) await this.readReply();
		} catch {
			// ignore
		}
		try {
			this.socket?.close();
		} catch {
			// ignore
		}
	}
}

export interface SendMailOptions {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	/** 完整 MIME 报文（由 buildMimeMessage 生成） */
	rawMessage: string;
	attachments?: Array<{ filename: string; contentType: string; dataBase64: string }>;
	inReplyTo?: string;
	references?: string;
}

export async function sendMail(
	hostname: string,
	port: number,
	username: string,
	password: string,
	opts: SendMailOptions,
): Promise<void> {
	const client = new SmtpClient(hostname, port);
	try {
		await client.connect();
		await client.ehlo();
		await client.authLogin(username, password);
		await client.mailFrom(opts.from);
		const recipients = [...opts.to, ...(opts.cc ?? []), ...(opts.bcc ?? [])];
		await client.rcptTo(recipients);
		await client.data(opts.rawMessage);
	} finally {
		await client.quit();
	}
}
