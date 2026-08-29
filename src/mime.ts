export interface OutboundAttachment {
	filename: string;
	contentType: string;
	dataBase64: string;
}

export interface BuildMailInput {
	from: string;
	to: string[];
	cc?: string[];
	subject: string;
	html: string;
	text?: string;
	attachments?: OutboundAttachment[];
	inReplyTo?: string;
	references?: string;
}

const CRLF = "\r\n";

function isAscii(value: string): boolean {
	return /^[\x20-\x7e]*$/.test(value);
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

function encodeWord(value: string): string {
	const clean = value.replace(/[\r\n]+/g, " ");
	if (isAscii(clean)) return clean;
	// RFC 2047：单个 encoded-word（含 =? ?= 定界符）≤75 字符。按 UTF-8 字节
	// 切块（每块 ≤45 字节 → base64 60 字符），逐块独立编码后以空格连接，
	// 解码端会忽略相邻 encoded-word 之间的空白并正确拼接。
	const bytes = new TextEncoder().encode(clean);
	const words: string[] = [];
	const chunkBytes = 45;
	let start = 0;
	while (start < bytes.length) {
		let end = Math.min(start + chunkBytes, bytes.length);
		while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // 回退到字符边界
		if (end === start) end = start + 1; // 防御：非法字节兜底
		words.push(`=?UTF-8?B?${utf8ToBase64(new TextDecoder().decode(bytes.slice(start, end)))}?=`);
		start = end;
	}
	return words.join(" ");
}

function encodeAddress(address: string): string {
	const match = address.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
	if (!match) return encodeWord(address);
	const [, name, email] = match;
	if (name.trim().length === 0) return email;
	return `${encodeWord(name)} <${email}>`;
}

function encodeAddressList(addresses: string[]): string {
	return addresses.map(encodeAddress).join(", ");
}

function randomToken(bytes = 20): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function textToHtml(text: string): string {
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
	return escaped
		.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.join("<br>");
}

function base64Wrap(b64: string, lineLength = 76): string {
	const lines: string[] = [];
	for (let i = 0; i < b64.length; i += lineLength) {
		lines.push(b64.slice(i, i + lineLength));
	}
	return lines.join(CRLF);
}

function plainPart(body: string): string {
	const b64 = base64Wrap(utf8ToBase64(body));
	return [
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		b64,
	].join(CRLF);
}

function htmlPart(body: string): string {
	const b64 = base64Wrap(utf8ToBase64(body));
	return [
		'Content-Type: text/html; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		b64,
	].join(CRLF);
}

function alternativePart(text: string, html: string): string {
	const boundary = `cfqm_alt_${randomToken()}`;
	const parts = [
		'Content-Type: multipart/alternative; boundary="' + boundary + '"',
		"",
		"--" + boundary,
		plainPart(text),
		"--" + boundary,
		htmlPart(html),
		"--" + boundary + "--",
	];
	return parts.join(CRLF);
}

function attachmentPart(att: OutboundAttachment): string {
	// filename 来自客户端：剥除可能破坏带引号字符串 / 注入头的字符
	const filename = encodeWord((att.filename || "attachment").replace(/[\r\n"]/g, ""));
	const ct = (att.contentType || "application/octet-stream").replace(/[\r\n"]/g, "");
	const encoded = base64Wrap(att.dataBase64);
	return [
		'Content-Type: ' + ct + '; name="' + filename + '"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="' + filename + '"',
		"",
		encoded,
	].join(CRLF);
}

export function buildMimeMessage(input: BuildMailInput): string {
	const headers: string[] = [];
	headers.push(`Date: ${new Date().toUTCString()}`);
	headers.push(`From: ${encodeAddress(input.from)}`);
	headers.push(`To: ${encodeAddressList(input.to)}`);
	if (input.cc && input.cc.length > 0) headers.push(`Cc: ${encodeAddressList(input.cc)}`);
	headers.push(`Subject: ${encodeWord(input.subject)}`);
	headers.push(`Message-ID: <${crypto.randomUUID()}@cfquickmail>`);
	// In-Reply-To / References 来自客户端，剥除 CR/LF 防止头注入
	if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]+/g, " ")}`);
	if (input.references) headers.push(`References: ${input.references.replace(/[\r\n]+/g, " ")}`);
	headers.push("MIME-Version: 1.0");

	const text = input.text ?? "";
	const html = input.html;
	const attachments = input.attachments ?? [];

	let body: string;
	if (attachments.length > 0) {
		const boundary = `cfqm_mixed_${randomToken()}`;
		headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		const innerBody = html ? alternativePart(text, html) : plainPart(text);
		const parts = ["--" + boundary, innerBody];
		for (const att of attachments) {
			parts.push("--" + boundary, attachmentPart(att));
		}
		parts.push("--" + boundary + "--");
		body = parts.join(CRLF);
	} else if (html && text) {
		const boundary = `cfqm_alt_${randomToken()}`;
		headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		body = [
			"--" + boundary,
			plainPart(text),
			"--" + boundary,
			htmlPart(html),
			"--" + boundary + "--",
		].join(CRLF);
	} else if (html) {
		headers.push('Content-Type: text/html; charset="UTF-8"');
		headers.push("Content-Transfer-Encoding: base64");
		body = base64Wrap(utf8ToBase64(html));
	} else {
		headers.push('Content-Type: text/plain; charset="UTF-8"');
		headers.push("Content-Transfer-Encoding: base64");
		body = base64Wrap(utf8ToBase64(text));
	}

	// Header block ends with CRLF, then a blank line (CRLF) separates the
	// headers from the body, then the body itself.
	return headers.join(CRLF) + CRLF + CRLF + body;
}

export { textToHtml };
