(() => {
	"use strict";

	const $ = (sel) => document.querySelector(sel);

	/* ---------------- theme ---------------- */
	function getStoredTheme() {
		try {
			return localStorage.getItem("cfqm_theme") || null;
		} catch {
			return null;
		}
	}

	function applyTheme(theme) {
		if (!theme) {
			theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		}
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem("cfqm_theme", theme);
		} catch {
			/* ignore */
		}
	}

	applyTheme(getStoredTheme());

	const state = {
		account: null,
		accounts: [],
		activeAccountId: null,
		folders: [],
		folderMap: new Map(),
		currentFolder: "INBOX",
		mode: "folder", // 'folder' | 'search'
		searchQuery: "",
		items: [],
		total: 0,
		offset: 0,
		pageSize: 50,
		selectedUid: null,
		composeAttachments: [],
		composeMeta: { inReplyTo: "", references: "" },
	};

	/* ---------------- utils ---------------- */
	function esc(s) {
		return String(s ?? "").replace(/[&<>"']/g, (c) => (
			{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
		));
	}

	function parseAddress(addr) {
		addr = String(addr || "").trim();
		const match = addr.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
		if (match) {
			const name = match[1].trim().replace(/^"|"$/g, "");
			// 某些非 UTF-8 编码的发件人名称会被解码成乱码（含替换字符），
			// 无法还原原始字节，回退为直接显示邮箱地址。
			if (name.includes("\uFFFD")) return { name: match[2].trim(), email: match[2].trim() };
			return { name: name || match[2], email: match[2].trim() };
		}
		return { name: addr, email: addr };
	}

	function initialsOf(addr) {
		const p = parseAddress(addr);
		const name = p.name || p.email;
		const first = name.trim().charAt(0);
		return first ? first.toUpperCase() : "?";
	}

	const AVATAR_COLORS = [
		"#611f69", "#1264a3", "#007a5a", "#e01e5a", "#c26b00",
		"#7c3aed", "#0e7c86", "#b3541e", "#5e3e0e", "#c62263",
	];
	function avatarColor(email) {
		let h = 0;
		for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
		return AVATAR_COLORS[h % AVATAR_COLORS.length];
	}

	function formatTime(iso) {
		const d = new Date(iso);
		const now = new Date();
		const pad = (n) => String(n).padStart(2, "0");
		const sameYear = d.getFullYear() === now.getFullYear();
		const sameDay =
			sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
		if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
		if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日`;
		return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
	}

	function formatSize(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	function textToHtml(text) {
		const escaped = esc(text);
		return escaped
			.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
			.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.join("<br>");
	}

	/* ---------------- icons ---------------- */
	const ms = (name) => `<span class="material-symbols-outlined">${name}</span>`;

	const ICONS = {
		inbox: ms("inbox"),
		sent: ms("send"),
		drafts: ms("draft"),
		trash: ms("delete"),
		archive: ms("archive"),
		spam: ms("report"),
		starred: ms("star"),
		other: ms("label"),
		read: ms("mark_email_read"),
		unread: ms("mark_email_unread"),
		archiveBox: ms("archive"),
		trashIcon: ms("delete"),
		attachment: ms("attach_file"),
		reply: ms("reply"),
		forward: ms("forward"),
	};

	const FOLDER_ICON = {
		inbox: ICONS.inbox,
		starred: ICONS.starred,
		sent: ICONS.sent,
		drafts: ICONS.drafts,
		archive: ICONS.archive,
		spam: ICONS.spam,
		trash: ICONS.trash,
		other: ICONS.other,
	};

	/* ---------------- api ---------------- */
	async function api(path, data) {
		const opts = { method: "GET", headers: {} };
		if (data !== undefined) {
			opts.method = "POST";
			opts.headers["Content-Type"] = "application/json";
			opts.body = JSON.stringify(data);
		}
		if (state.activeAccountId) {
			opts.headers["X-Account-Id"] = state.activeAccountId;
		}
		const res = await fetch(path, opts);
		let json = null;
		try {
			json = await res.json();
		} catch {
			/* ignore */
		}
		if (!res.ok) {
			const err = new Error((json && json.error) || `请求失败 (${res.status})`);
			if (json && json.needTotp) err.needTotp = true;
			if (json && json.needTurnstile) err.needTurnstile = true;
			throw err;
		}
		return json;
	}

	/* ---------------- toast ---------------- */
	function toast(message, type = "") {
		const el = document.createElement("div");
		el.className = `toast ${type}`;
		el.textContent = message;
		$("#toast-container").appendChild(el);
		setTimeout(() => {
			el.style.opacity = "0";
			el.style.transition = "opacity .3s";
			setTimeout(() => el.remove(), 320);
		}, 2600);
	}

	function confirmDialog(title, message) {
		return new Promise((resolve) => {
			$("#confirm-title").textContent = title;
			$("#confirm-message").textContent = message;
			$("#confirm-overlay").hidden = false;
			const done = (val) => {
				$("#confirm-overlay").hidden = true;
				$("#confirm-ok").onclick = null;
				$("#confirm-cancel").onclick = null;
				resolve(val);
			};
			$("#confirm-ok").onclick = () => done(true);
			$("#confirm-cancel").onclick = () => done(false);
			$("#confirm-overlay").onclick = (e) => {
				if (e.target === $("#confirm-overlay")) done(false);
			};
		});
	}

	/* ---------------- auth ---------------- */
	function showLogin() {
		$("#login-view").hidden = false;
		$("#app-view").hidden = true;
		$("#login-password").focus();
	}

	function showApp() {
		$("#login-view").hidden = true;
		$("#app-view").hidden = false;
	}

	/* ---------------- folder helpers ---------------- */
	function folderOfKind(kind) {
		return state.folders.find((f) => f.kind === kind);
	}

	function folderName(kind) {
		const f = folderOfKind(kind);
		return f ? f.name : null;
	}

	function folderDisplayName(name) {
		const kinds = {
			inbox: "收件箱",
			sent: "已发送",
			drafts: "草稿箱",
			trash: "回收站",
			archive: "归档",
			spam: "垃圾邮件",
			starred: "星标",
		};
		const f = state.folders.find((x) => x.name === name);
		if (f && kinds[f.kind]) return kinds[f.kind];
		return name;
	}

	/* ---------------- folders render ---------------- */
	function renderFolders() {
		const list = $("#folder-list");
		list.innerHTML = "";
		for (const folder of state.folders) {
			const label = folderDisplayName(folder.name);
			const unread = folder.unread || 0;
			const item = document.createElement("button");
			item.className = "folder-item" + (unread > 0 ? " unread" : "");
			item.dataset.name = folder.name;
			if (folder.name === state.currentFolder && state.mode === "folder") item.classList.add("active");
			item.innerHTML =
				`<span class="folder-icon">${FOLDER_ICON[folder.kind] || FOLDER_ICON.other}</span>` +
				`<span class="folder-name" title="${esc(folder.name)}">${esc(label)}</span>` +
				(unread > 0 ? `<span class="folder-count">${unread}</span>` : "");
			item.addEventListener("click", () => selectFolder(folder.name));
			list.appendChild(item);
		}
		updateSidebarHeader();
	}

	function updateSidebarHeader() {
		$("#account-email").textContent = state.account ? state.account.email : "";
		applyAvatar(currentAvatarUrl);
	}

	/* ---------------- 头像 ---------------- */
	let currentAvatarUrl = null;

	function applyAvatar(dataUrl) {
		currentAvatarUrl = dataUrl || null;
		const avatar = $("#account-avatar");
		if (!avatar) return;
		if (currentAvatarUrl) {
			avatar.textContent = "";
			avatar.style.background = `center / cover no-repeat url("${currentAvatarUrl}")`;
			avatar.dataset.custom = "1";
		} else {
			delete avatar.dataset.custom;
			if (state.account) {
				avatar.textContent = initialsOf(state.account.from || state.account.email);
				avatar.style.background = avatarColor(state.account.email);
			}
		}
	}

	async function loadAvatar() {
		try {
			const data = await api("/api/avatar");
			applyAvatar(data.dataUrl);
		} catch {
			/* 头像加载失败不影响主流程 */
		}
	}

	/* ---------------- 多账号切换 ---------------- */
	function closeAccountMenu() {
		const menu = $("#account-menu");
		if (menu) menu.hidden = true;
	}

	function renderAccountMenu() {
		const menu = $("#account-menu");
		if (!menu) return;
		menu.innerHTML = "";
		for (const acc of state.accounts) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "account-menu-item" + (acc.id === state.activeAccountId ? " active" : "");
			btn.setAttribute("role", "menuitem");
			btn.innerHTML =
				`<span class="account-menu-avatar" style="background:${avatarColor(acc.email)}">${esc(initialsOf(acc.email))}</span>` +
				`<span class="account-menu-text">` +
				`<span class="account-menu-label">${esc(acc.label || acc.email)}</span>` +
				`<span class="account-menu-email">${esc(acc.email)}</span>` +
				`</span>`;
			btn.addEventListener("click", () => switchAccount(acc.id));
			menu.appendChild(btn);
		}
	}

	function toggleAccountMenu() {
		const menu = $("#account-menu");
		if (!menu) return;
		menu.hidden = !menu.hidden;
	}

	async function switchAccount(id) {
		if (!id || id === state.activeAccountId) {
			closeAccountMenu();
			return;
		}
		try {
			await api("/api/accounts/active", { id });
			// 后端已下发新的会话 Cookie，重载页面让所有缓存状态重建（最简、最稳）
			location.reload();
		} catch (e) {
			toast(e.message, "error");
			closeAccountMenu();
		}
	}

	async function loadAccounts() {
		try {
			const data = await api("/api/accounts");
			state.accounts = data.accounts || [];
			state.activeAccountId = data.active || null;
			// 单账号时隐藏切换下拉箭头，避免让用户觉得有未启用的功能
			const caret = $("#account-chip-caret");
			if (caret) caret.hidden = state.accounts.length <= 1;
			const chip = $("#account-chip");
			if (chip) chip.title = state.accounts.length > 1 ? "切换账号" : "当前账号";
			renderAccountMenu();
		} catch {
			/* 账号列表拉取失败不影响主流程 */
		}
	}

	function refreshUnreadBadges() {
		renderFolders();
	}

	function setCurrentFolderBadge(name, delta) {
		const f = state.folders.find((x) => x.name === name);
		if (f) {
			f.unread = Math.max(0, (f.unread || 0) + delta);
		}
	}

	/* ---------------- folder select ---------------- */
	async function selectFolder(name) {
		state.mode = "folder";
		state.currentFolder = name;
		state.selectedUid = null;
		// 移动端：选完文件夹自动收起抽屉
		if (isNarrowScreen()) {
			const app = document.getElementById("app-view");
			app?.classList.add("nav-collapsed");
			const scrim = document.getElementById("drawer-scrim");
			if (scrim) scrim.hidden = true;
		}
		$("#search-input").value = "";
		$("#search-clear").hidden = true;
		renderFolders();
		clearReadingPane();
		await loadList(0);
	}

	function jumpToKind(kind) {
		const f = folderOfKind(kind);
		if (f) selectFolder(f.name);
	}

	/* ---------------- email list ---------------- */
	function showListLoading() {
		$("#list-loading").hidden = false;
		$("#list-empty").hidden = true;
		$("#email-list").innerHTML = "";
		$("#list-more").hidden = true;
	}

	async function loadList(offset) {
		const folder = state.currentFolder;
		state.offset = offset;
		showListLoading();
		try {
			const data = await api(`/api/emails?folder=${encodeURIComponent(folder)}&offset=${offset}&limit=${state.pageSize}`);
			if (offset === 0) state.items = data.items;
			else state.items = state.items.concat(data.items);
			state.total = data.total;
			renderList();
		} catch (e) {
			$("#list-loading").hidden = true;
			$("#list-empty").hidden = false;
			$("#list-empty").innerHTML = `<p>${esc(e.message)}</p>`;
		}
	}

	function renderList() {
		const listEl = $("#email-list");
		listEl.innerHTML = "";
		$("#list-loading").hidden = true;

		if (state.items.length === 0) {
			$("#list-empty").hidden = false;
			$("#list-empty").innerHTML =
				`<div class="empty-icon">${ICONS.inbox}</div><p>${state.mode === "search" ? "没有匹配的邮件" : "这里还没有邮件"}</p>`;
			$("#list-more").hidden = true;
			updateToolbar();
			return;
		}

		$("#list-empty").hidden = true;
		for (const item of state.items) {
			listEl.appendChild(renderListItem(item));
		}
		$("#list-more").hidden = state.offset + state.items.length >= state.total;
		updateToolbar();
	}

	function renderListItem(item) {
		const sender = item.from && item.from.length > 0 ? item.from[0] : "(未知发件人)";
		const p = parseAddress(sender);
		const unread = !item.read;

		const li = document.createElement("li");
		li.className = "email-item" + (unread ? " unread" : "") + (item.uid === state.selectedUid ? " selected" : "");
		li.dataset.uid = item.uid;

		const archiveDest = folderName("archive");
		const inTrash = state.currentFolder === folderName("trash");
		const starred = !!item.flagged;

		li.innerHTML =
			`<button class="star-btn${starred ? " star-on" : ""}" data-action="star" title="${starred ? "移除星标" : "添加星标"}">${ICONS.starred}</button>` +
			`<span class="email-sender" title="${esc(p.name || p.email)}">${esc(p.name || p.email)}</span>` +
			`<span class="email-mid">` +
			`<span class="email-subject-text">${esc(item.subject || "(无主题)")}</span>` +
			(item.hasAttachments ? `<span class="email-att-icon" title="含附件">${ICONS.attachment}</span>` : "") +
			`</span>` +
			`<span class="email-date">${esc(formatTime(item.internalDate))}</span>` +
			`<span class="email-hover-actions">` +
			`<button class="icon-btn" data-action="toggle-read" title="${unread ? "标为已读" : "标为未读"}">${unread ? ICONS.read : ICONS.unread}</button>` +
			(archiveDest && !inTrash ? `<button class="icon-btn" data-action="archive" title="归档">${ICONS.archiveBox}</button>` : "") +
			`<button class="icon-btn" data-action="delete" title="删除">${ICONS.trashIcon}</button>` +
			`</span>`;

		li.addEventListener("click", (e) => {
			if (e.target.closest("[data-action]")) return;
			openEmail(item.uid);
		});

		const actions = li.querySelectorAll("[data-action]");
		actions.forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const action = btn.dataset.action;
				if (action === "star") await toggleStar(item, btn);
				else if (action === "toggle-read") await toggleRead(item, li);
				else if (action === "archive") await archiveItem(item, li);
				else if (action === "delete") await deleteItem(item, li);
			});
		});

		return li;
	}

	async function toggleStar(item, btn) {
		const action = item.flagged ? "remove" : "add";
		try {
			await api("/api/flags", { folder: state.currentFolder, uids: [item.uid], flags: ["\\Flagged"], action });
			item.flagged = !item.flagged;
			btn.classList.toggle("star-on", item.flagged);
			btn.title = item.flagged ? "移除星标" : "添加星标";
		} catch (e) {
			toast(e.message, "error");
		}
	}

	function updateToolbar() {
		const from = state.items.length > 0 ? state.offset + 1 : 0;
		const to = state.offset + state.items.length;
		const range = `第 ${from} - ${to} 行，共 ${state.total} 行`;
		if (state.mode === "search") {
			$("#toolbar-title").textContent = "搜索结果";
			$("#toolbar-subtitle").textContent = `“${state.searchQuery}” · ${range}`;
			$("#btn-back").hidden = false;
		} else {
			$("#toolbar-title").textContent = folderDisplayName(state.currentFolder);
			$("#toolbar-subtitle").textContent = range;
			$("#btn-back").hidden = true;
		}
	}

	function removeItemFromList(uid) {
		const idx = state.items.findIndex((i) => i.uid === uid);
		if (idx === -1) return;
		state.items.splice(idx, 1);
		state.total = Math.max(0, state.total - 1);
		const row = $(`[data-uid="${uid}"]`);
		if (row) row.remove();
		if (state.items.length === 0 && state.total === 0) {
			renderList();
		}
		updateToolbar();
		$("#list-more").hidden = state.offset + state.items.length >= state.total;
	}

	function markRowRead(uid, read) {
		const row = $(`[data-uid="${uid}"]`);
		const item = state.items.find((i) => i.uid === uid);
		if (item) item.read = read;
		if (!row) return;
		row.classList.toggle("unread", !read);
	}

	/* ---------------- email actions ---------------- */
	async function toggleRead(item, li) {
		const action = item.read ? "remove" : "add";
		try {
			await api("/api/flags", { folder: state.currentFolder, uids: [item.uid], flags: ["Seen"], action });
			markRowRead(item.uid, !item.read);
			setCurrentFolderBadge(state.currentFolder, item.read ? 1 : -1);
			refreshUnreadBadges();
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function archiveItem(item, li) {
		const dest = folderName("archive");
		if (!dest) return;
		try {
			await api("/api/move", { folder: state.currentFolder, uids: [item.uid], dest });
			if (item.uid === state.selectedUid) clearReadingPane();
			removeItemFromList(item.uid);
			toast("已归档", "success");
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function deleteItem(item, li) {
		const trash = folderName("trash");
		const inTrash = state.currentFolder === trash;
		let permanent = inTrash;
		if (inTrash) {
			const ok = await confirmDialog("永久删除", "该操作会彻底删除这封邮件，且无法恢复。确定继续吗？");
			if (!ok) return;
		}
		try {
			await api("/api/delete", { folder: state.currentFolder, uids: [item.uid], permanent });
			if (item.uid === state.selectedUid) clearReadingPane();
			removeItemFromList(item.uid);
			toast(permanent ? "已永久删除" : "已删除", "success");
		} catch (e) {
			toast(e.message, "error");
		}
	}

	/* ---------------- reading pane ---------------- */
	function isNarrowScreen() {
		return window.innerWidth <= 860;
	}

	/** 移动端：阅读窗格覆盖层开/关（桌面端该 class 无样式效果） */
	function setReadingOpen(open) {
		document.getElementById("reading-pane")?.classList.toggle("open", open);
	}

	function clearReadingPane() {
		state.selectedUid = null;
		setReadingOpen(false);
		$("#reading-loading").hidden = true;
		$("#reading-empty").hidden = false;
		$("#email-view").hidden = true;
		$("#email-view").innerHTML = "";
		document.querySelectorAll(".email-item.selected").forEach((el) => el.classList.remove("selected"));
	}

	function showReadingLoading() {
		setReadingOpen(true);
		$("#reading-loading").hidden = false;
		$("#reading-empty").hidden = true;
		$("#email-view").hidden = true;
	}

	async function openEmail(uid) {
		state.selectedUid = uid;
		document.querySelectorAll(".email-item.selected").forEach((el) => el.classList.remove("selected"));
		const row = $(`[data-uid="${uid}"]`);
		if (row) row.classList.add("selected");
		showReadingLoading();
		try {
			const data = await api(`/api/email?folder=${encodeURIComponent(state.currentFolder)}&uid=${uid}&read=1`);
			if (!data.email) throw new Error("邮件不存在");
			markRowRead(uid, true);
			setCurrentFolderBadge(state.currentFolder, -1);
			refreshUnreadBadges();
			renderEmail(data.email);
		} catch (e) {
			$("#reading-loading").hidden = true;
			$("#reading-empty").hidden = false;
			$("#reading-empty").innerHTML = `<p>${esc(e.message)}</p>`;
		}
	}

	function renderEmail(email) {
		$("#reading-loading").hidden = true;
		const view = $("#email-view");
		view.hidden = false;
		view.innerHTML = "";

		// 移动端：阅读覆盖层顶部的返回按钮（桌面端由 CSS 隐藏）
		const back = document.createElement("button");
		back.className = "email-mobile-back";
		back.innerHTML = '<span class="material-symbols-outlined">arrow_back_ios_new</span>返回';
		back.addEventListener("click", () => clearReadingPane());
		view.appendChild(back);

		const senderRaw = email.from && email.from.length > 0 ? email.from[0] : "(未知发件人)";
		const p = parseAddress(senderRaw);
		const toLine = email.to && email.to.length ? email.to.join(", ") : "";
		const ccLine = email.cc && email.cc.length ? email.cc.join(", ") : "";
		const dateText = new Date(email.internalDate).toLocaleString("zh-CN", {
			year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
		});
		const read = email.read;

		const head = document.createElement("div");
		head.className = "email-head";
		head.innerHTML =
			`<h1 class="email-head-subject">${esc(email.subject || "(无主题)")}</h1>` +
			`<div class="email-head-meta">` +
			`<div class="email-head-from">` +
			`<span class="avatar avatar-lg" style="background:${avatarColor(p.email)}">${esc(initialsOf(p.email))}</span>` +
			`<div class="email-head-names">` +
			`<div class="email-head-name">${esc(p.name || p.email)}</div>` +
			`<div class="email-head-address">&lt;${esc(p.email)}&gt;</div>` +
			`</div>` +
			`</div>` +
			`<div class="email-head-date">${esc(dateText)}</div>` +
			`</div>` +
			(toLine ? `<div class="email-head-to">收件人：${esc(toLine)}</div>` : "") +
			(ccLine ? `<div class="email-head-to">抄送：${esc(ccLine)}</div>` : "");

		const actions = document.createElement("div");
		actions.className = "email-actions";
		actions.innerHTML =
			`<button class="btn btn-primary" data-act="reply">${ICONS.reply} 回复</button>` +
			`<button class="btn btn-secondary" data-act="forward">${ICONS.forward} 转发</button>` +
			`<button class="btn btn-secondary" data-act="toggle-read">${read ? "标为未读" : "标为已读"}</button>` +
			`<button class="btn btn-secondary" data-act="archive">归档</button>` +
			`<button class="btn btn-secondary" data-act="delete">删除</button>`;

		const body = document.createElement("div");
		body.className = "email-body-box";
		let remoteImgCount = 0;
		if (email.bodyHtml) {
			const root = sanitizeHtml(email.bodyHtml, email.attachments);
			for (const node of [...root.childNodes]) body.appendChild(node);
			remoteImgCount = blockRemoteImages(body);
			bindExternalLinks(body);
		} else {
			const pre = document.createElement("div");
			pre.className = "email-body-plain";
			pre.textContent = email.bodyText || "";
			body.appendChild(pre);
		}

		const attachmentsBox = document.createElement("div");
		if (email.attachments && email.attachments.length > 0) {
			attachmentsBox.className = "attachments-box";
			const title = document.createElement("div");
			title.className = "attachments-title";
			title.textContent = `附件 (${email.attachments.length})`;
			attachmentsBox.appendChild(title);
			for (const att of email.attachments) {
				attachmentsBox.appendChild(renderAttachment(att));
			}
		}

		view.appendChild(head);
		view.appendChild(actions);
		view.appendChild(body);
		if (attachmentsBox.children.length) view.appendChild(attachmentsBox);

		if (remoteImgCount > 0) {
			const banner = document.createElement("div");
			banner.className = "remote-img-banner";
			banner.innerHTML =
				`<span>此邮件包含远程图片，加载后可能泄露你的访问行为。</span>` +
				`<button type="button" class="btn btn-secondary btn-xs">加载远程图片（${remoteImgCount}）</button>`;
			const btn = banner.querySelector("button");
			btn.addEventListener("click", () => {
				body.querySelectorAll("img.remote-img").forEach((img) => {
					const src = img.dataset.src;
					if (src) img.src = src;
					img.classList.remove("remote-img");
				});
				banner.remove();
			});
			view.insertBefore(banner, body.nextSibling);
		}

		actions.querySelectorAll("[data-act]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const act = btn.dataset.act;
				if (act === "reply") openCompose({ mode: "reply", email });
				else if (act === "forward") openCompose({ mode: "forward", email });
				else if (act === "toggle-read") toggleReadFromPane(email);
				else if (act === "archive") archiveFromPane(email);
				else if (act === "delete") deleteFromPane(email);
			});
		});
	}

	function renderAttachment(att) {
		const card = document.createElement("div");
		card.className = "attachment-card";
		card.innerHTML =
			`<span class="attachment-icon">${ICONS.attachment}</span>` +
			`<div class="attachment-info">` +
			`<div class="attachment-name">${esc(att.filename || "附件")}</div>` +
			`<div class="attachment-size">${esc(formatSize(att.size))} · ${esc(att.mimeType)}</div>` +
			`</div>` +
			`<a class="attachment-download" href="#" download="${esc(att.filename || "attachment")}">下载</a>`;
		const a = card.querySelector(".attachment-download");
		a.addEventListener("click", (e) => {
			e.preventDefault();
			try {
				const bytes = base64ToBytes(att.contentBase64);
				const blob = new Blob([bytes], { type: att.mimeType || "application/octet-stream" });
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = att.filename || "attachment";
				document.body.appendChild(link);
				link.click();
				link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 4000);
			} catch {
				toast("附件下载失败", "error");
			}
		});
		return card;
	}

	function base64ToBytes(b64) {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	}

	/* ---------------- HTML sanitizer ---------------- */
	const ALLOWED_TAGS = new Set([
		"A", "ABBR", "ADDRESS", "ARTICLE", "ASIDE", "B", "BLOCKQUOTE", "BR", "CAPTION", "CITE", "CODE",
		"COL", "COLGROUP", "DD", "DEL", "DETAILS", "DFN", "DIV", "DL", "DT", "EM", "FIGCAPTION", "FIGURE",
		"FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "I", "IMG", "INS", "KBD", "LI",
		"MAIN", "MARK", "NAV", "OL", "P", "PRE", "Q", "S", "SAMP", "SECTION", "SMALL", "SPAN", "STRONG",
		"SUB", "SUMMARY", "SUP", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TIME", "TR", "U", "UL",
		"VAR", "WBR",
	]);
	const DISALLOWED_TAGS = ["SCRIPT", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "LINK", "META", "BASE", "NOSCRIPT", "FRAME", "STYLE"];
	// URL 用白名单而非黑名单：浏览器 URL 解析器会先剔除 scheme 里的 ASCII
	// Tab/LF/CR 再判定协议（`java\nscript:` 会被当作 javascript:），黑名单若不做
	// 同样归一化即可被绕过。这里先剥掉控制字符再按白名单匹配。
	const SAFE_URL_SCHEME_RE =
		/^(?:https?:|mailto:|tel:|#|data:image\/(?:png|jpe?g|gif|webp|bmp|avif|tiff?);|data:application\/octet-stream;)/i;

	function isSafeUrl(value) {
		return SAFE_URL_SCHEME_RE.test(String(value).replace(/[\t\n\r]/g, "").trim());
	}

	// style 中禁止任何 url(...)：现代浏览器里 CSS 不能直接执行脚本，但
	// background:url(https://...) 这类外联会绕过「远程图片不加载」的拦截，
	// 在读信瞬间外泄访问行为（等效跟踪像素）。
	const DANGEROUS_CSS_RE = /url\s*\(|expression\s*\(|-moz-binding|behavior\s*:/gi;

	const BLOCKED_IMG =
		"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

	/** 邮件里的远程图片默认不加载，防止跟踪像素 / 泄露访问行为。 */
	function blockRemoteImages(root) {
		let count = 0;
		for (const img of [...(root.querySelectorAll ? root.querySelectorAll("img") : [])]) {
			const src = img.getAttribute("src") || "";
			if (/^https?:|^\/\//i.test(src)) {
				img.dataset.src = src;
				img.setAttribute("src", BLOCKED_IMG);
				img.classList.add("remote-img");
				count++;
			}
		}
		return count;
	}

	function cidToDataUrl(html, attachments) {
		let out = html;
		for (const att of attachments || []) {
			if (att.contentId && att.isInline) {
				const cid = att.contentId.replace(/[<>]/g, "");
				const re = new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
				out = out.replace(re, `data:${att.mimeType || "application/octet-stream"};base64,${att.contentBase64}`);
			}
		}
		return out;
	}

	function sanitizeHtml(html, attachments) {
		const doc = new DOMParser().parseFromString(cidToDataUrl(html, attachments), "text/html");
		const container = doc.createElement("div");
		container.appendChild(doc.body);
		for (const el of [...container.querySelectorAll("*")]) {
			if (DISALLOWED_TAGS.includes(el.tagName)) {
				el.remove();
				continue;
			}
			for (const attr of [...el.attributes]) {
				const name = attr.name.toLowerCase();
				if (name.startsWith("on")) {
					el.removeAttribute(attr.name);
				} else if (name === "href" || name === "src" || name === "poster" || name === "action" || name === "xlink:href") {
					if (!isSafeUrl(attr.value)) el.removeAttribute(attr.name);
				} else if (name === "style") {
					if (DANGEROUS_CSS_RE.test(attr.value)) el.removeAttribute(attr.name);
				} else if (name === "target" || name === "rel") {
					// 剥掉 target/rel，强制所有链接走 bindExternalLinks 的
					// window.open(href, "_blank", "noopener")，防止邮件用
					// target="_self"/"..." 劫持同 frame 导航。
					el.removeAttribute(attr.name);
				}
			}
			if (!ALLOWED_TAGS.has(el.tagName)) {
				el.replaceWith(...el.childNodes);
			}
		}
		return container;
	}

	function bindExternalLinks(root) {
		root.addEventListener("click", (e) => {
			const a = e.target.closest("a");
			if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
			const href = a.getAttribute("href") || "";
			if (href.startsWith("mailto:") || href.startsWith("#")) return;
			if (!a.getAttribute("target")) {
				e.preventDefault();
				window.open(href, "_blank", "noopener");
			}
		});
	}

	/* ---------------- reading actions ---------------- */
	function currentEmailFromState() {
		if (!state.selectedUid) return null;
		return state.items.find((i) => i.uid === state.selectedUid) || null;
	}

	async function toggleReadFromPane(email) {
		const action = email.read ? "remove" : "add";
		try {
			await api("/api/flags", { folder: state.currentFolder, uids: [email.uid], flags: ["Seen"], action });
			email.read = !email.read;
			markRowRead(email.uid, email.read);
			setCurrentFolderBadge(state.currentFolder, email.read ? 1 : -1);
			refreshUnreadBadges();
			renderEmail({ ...email, read: email.read });
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function archiveFromPane(email) {
		const dest = folderName("archive");
		if (!dest) return;
		try {
			await api("/api/move", { folder: state.currentFolder, uids: [email.uid], dest });
			removeItemFromList(email.uid);
			clearReadingPane();
			toast("已归档", "success");
		} catch (e) {
			toast(e.message, "error");
		}
	}

	async function deleteFromPane(email) {
		const trash = folderName("trash");
		const inTrash = state.currentFolder === trash;
		let permanent = inTrash;
		if (inTrash) {
			const ok = await confirmDialog("永久删除", "该操作会彻底删除这封邮件，且无法恢复。确定继续吗？");
			if (!ok) return;
		}
		try {
			await api("/api/delete", { folder: state.currentFolder, uids: [email.uid], permanent });
			removeItemFromList(email.uid);
			clearReadingPane();
			toast(permanent ? "已永久删除" : "已删除", "success");
		} catch (e) {
			toast(e.message, "error");
		}
	}

	/* ---------------- compose ---------------- */
	function openCompose(opts = {}) {
		state.composeAttachments = [];
		const f = $("#compose-form");
		f.reset();
		$("#compose-title").textContent = "新邮件";
		$("#compose-cc").closest(".compose-field").hidden = true;
		$("#compose-bcc").closest(".compose-field").hidden = true;
		$("#compose-cc").value = "";
		$("#compose-bcc").value = "";
		state.composeMeta = { inReplyTo: "", references: "" };

		if (opts.mode === "reply" && opts.email) {
			const sender = opts.email.from && opts.email.from[0] ? opts.email.from[0] : "";
			const p = parseAddress(sender);
			$("#compose-title").textContent = "回复";
			$("#compose-to").value = p.name && p.name !== p.email ? `${p.name} <${p.email}>` : p.email;
			$("#compose-subject").value = (opts.email.subject || "").replace(/^re:\s*/i, "") ? `Re: ${opts.email.subject.replace(/^re:\s*/i, "")}` : `Re: ${opts.email.subject}`;
			const quoted = quoteText(opts.email.bodyText || "");
			$("#compose-body").value = quoted;
			state.composeMeta.inReplyTo = opts.email.messageID || "";
			state.composeMeta.references = buildReferences(opts.email.references, opts.email.messageID);
			if (opts.email.cc && opts.email.cc.length) {
				$("#compose-cc").value = opts.email.cc.join(", ");
				$("#compose-cc").closest(".compose-field").hidden = false;
			}
		} else if (opts.mode === "forward" && opts.email) {
			$("#compose-title").textContent = "转发";
			$("#compose-subject").value = `Fwd: ${opts.email.subject.replace(/^fwd:\s*/i, "")}`;
			const forwarded = `\n\n---------- 转发邮件 ----------\n发件人: ${(opts.email.from || []).join(", ")}\n日期: ${new Date(opts.email.internalDate).toLocaleString("zh-CN")}\n主题: ${opts.email.subject}\n\n${opts.email.bodyText || ""}`;
			$("#compose-body").value = forwarded;
			state.composeMeta.forward = "1";
		}

		renderComposeAttachments();
		$("#compose-overlay").hidden = false;
		setTimeout(() => $("#compose-to").focus(), 60);
	}

	function closeCompose() {
		$("#compose-overlay").hidden = true;
	}

	function buildReferences(existing, messageId) {
		const refs = existing
			? String(existing).split(/\s+/).filter(Boolean)
			: [];
		if (messageId) refs.push(messageId);
		return refs.join(" ");
	}

	function quoteText(text) {
		if (!text) return "";
		return text
			.split(/\r?\n/)
			.map((line) => (line ? `> ${line}` : ">"))
			.join("\n") + "\n";
	}

	function renderComposeAttachments() {
		const list = $("#attachment-list");
		list.innerHTML = "";
		for (const att of state.composeAttachments) {
			const el = document.createElement("div");
			el.className = "compose-att-item";
			el.innerHTML = `<span class="att-icon">${ICONS.attachment}</span><span class="att-name">${esc(att.filename)}</span><span class="att-size">${esc(formatSize(att.size))}</span><button type="button" class="att-remove" title="移除">&times;</button>`;
			el.querySelector(".att-remove").addEventListener("click", () => {
				state.composeAttachments = state.composeAttachments.filter((x) => x !== att);
				renderComposeAttachments();
			});
			list.appendChild(el);
		}
	}

	function parseRecipients(value) {
		return value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	async function submitCompose() {
		const to = parseRecipients($("#compose-to").value);
		const cc = parseRecipients($("#compose-cc").value);
		const bcc = parseRecipients($("#compose-bcc").value);
		const subject = $("#compose-subject").value.trim();
		const text = $("#compose-body").value;

		if (to.length === 0) {
			toast("请填写收件人", "error");
			return;
		}

		const sendBtn = $("#compose-send");
		sendBtn.disabled = true;
		sendBtn.querySelector(".btn-label").textContent = "发送中…";
		try {
			await api("/api/send", {
				to,
				cc,
				bcc,
				subject,
				text,
				html: textToHtml(text),
				attachments: state.composeAttachments.map((a) => ({
					filename: a.filename,
					contentType: a.contentType || "application/octet-stream",
					dataBase64: a.dataBase64,
				})),
				inReplyTo: state.composeMeta.inReplyTo || undefined,
				references: state.composeMeta.references || undefined,
			});
			closeCompose();
			toast("邮件已发送", "success");
			refreshFoldersAndList();
		} catch (e) {
			toast(e.message, "error");
		} finally {
			sendBtn.disabled = false;
			sendBtn.querySelector(".btn-label").textContent = "发送";
		}
	}

	async function refreshFoldersAndList() {
		try {
			await loadFolders();
		} catch {
			/* ignore */
		}
		await loadList(0);
	}

	/* ---------------- search ---------------- */
	async function doSearch() {
		const q = $("#search-input").value.trim();
		if (!q) return;
		state.mode = "search";
		state.searchQuery = q;
		state.selectedUid = null;
		$("#search-clear").hidden = false;
		$("#btn-back").hidden = false;
		clearReadingPane();
		showListLoading();
		try {
			const data = await api(`/api/search?folder=${encodeURIComponent(state.currentFolder)}&q=${encodeURIComponent(q)}`);
			state.items = data.items;
			state.total = data.total;
			state.offset = 0;
			renderList();
		} catch (e) {
			$("#list-loading").hidden = true;
			$("#list-empty").hidden = false;
			$("#list-empty").innerHTML = `<p>${esc(e.message)}</p>`;
		}
	}

	function exitSearch() {
		state.mode = "folder";
		state.searchQuery = "";
		$("#search-input").value = "";
		$("#search-clear").hidden = true;
		loadList(0);
	}

	/* ---------------- refresh ---------------- */
	async function refreshAll() {
		loadAvatar();
		loadAccounts();
		try {
			await loadFolders();
		} catch (e) {
			toast(e.message, "error");
			return;
		}
		await loadList(0);
	}

	/* ---------------- settings modal ---------------- */
	function showSettings() {
		const overlay = document.createElement("div");
		overlay.className = "overlay overlay-confirm";
		const account = state.account || {};
		overlay.innerHTML =
			`<div class="confirm-modal">` +
			`<h3>账户设置</h3>` +
			`<div class="settings-body">` +
			`<div class="settings-avatar-row">` +
			`<div id="settings-avatar-preview" class="avatar avatar-lg"></div>` +
			`<div class="settings-avatar-actions">` +
			`<label class="btn btn-secondary btn-xs settings-upload-btn">上传头像` +
			`<input id="avatar-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden /></label>` +
			`<button id="avatar-remove" class="btn btn-secondary btn-xs">移除头像</button>` +
			`<span class="settings-avatar-hint">≤ 256KB，存于 Cloudflare KV</span>` +
			`</div>` +
			`</div>` +
			`<p><strong>邮箱账号：</strong><span class="settings-mute">${esc(account.email || "")}</span></p>` +
			`<p class="settings-mute">IMAP / SMTP 主机、端口、账号与密码通过 Cloudflare Workers Secrets（wrangler secret put）配置，不会在网页中存储或回显。</p>` +
			`<p class="settings-mute">修改凭据后重新部署 Worker 即可生效。</p>` +
			`</div>` +
			`<div class="confirm-actions"><button class="btn btn-secondary" data-close>关闭</button></div>` +
			`</div>`;
		document.body.appendChild(overlay);
		const close = () => overlay.remove();
		overlay.querySelector("[data-close]").addEventListener("click", close);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close();
		});

		const preview = overlay.querySelector("#settings-avatar-preview");
		if (currentAvatarUrl) {
			preview.textContent = "";
			preview.style.background = `center / cover no-repeat url("${currentAvatarUrl}")`;
			preview.dataset.custom = "1";
		} else if (state.account) {
			preview.textContent = initialsOf(state.account.from || state.account.email);
			preview.style.background = avatarColor(state.account.email);
		}

		overlay.querySelector("#avatar-input").addEventListener("change", async (e) => {
			const file = (e.target.files || [])[0];
			e.target.value = "";
			if (!file) return;
			if (file.size > 256 * 1024) {
				toast("图片超过 256KB，请压缩后再上传", "error");
				return;
			}
			try {
				const dataUrl = await fileToDataUrl(file);
				await api("/api/avatar", { dataUrl });
				applyAvatar(dataUrl);
				preview.textContent = "";
				preview.style.background = `center / cover no-repeat url("${dataUrl}")`;
				preview.dataset.custom = "1";
				toast("头像已更新", "success");
			} catch (err) {
				toast(err.message, "error");
			}
		});

		overlay.querySelector("#avatar-remove").addEventListener("click", async () => {
			try {
				await api("/api/avatar", { clear: true });
				applyAvatar(null);
				preview.textContent = state.account ? initialsOf(state.account.from || state.account.email) : "";
				preview.style.background = state.account ? avatarColor(state.account.email) : "";
				delete preview.dataset.custom;
				toast("已移除自定义头像", "success");
			} catch (err) {
				toast(err.message, "error");
			}
		});
	}

	/* ---------------- events ---------------- */
	function bindEvents() {
		$("#login-form").addEventListener("submit", async (e) => {
			e.preventDefault();
			const btn = $("#login-btn");
			btn.disabled = true;
			btn.textContent = "登录中…";
			$("#login-error").hidden = true;
			try {
				const payload = { password: $("#login-password").value };
				const totp = $("#login-totp")?.value.trim();
				if (totp) payload.totp = totp;
				if (window.__cfqmTurnstileToken) payload.turnstileToken = window.__cfqmTurnstileToken;
				const me = await api("/api/login", payload);
				state.account = me;
				showApp();
				await refreshAll();
			} catch (err) {
				$("#login-error").textContent = err.message;
				$("#login-error").hidden = false;
				if (err.needTotp) {
					$("#login-totp-field").hidden = false;
					$("#login-totp")?.focus();
				}
				if (err.needTurnstile) resetTurnstile();
			} finally {
				btn.disabled = false;
				btn.textContent = "登 录";
			}
		});

		$("#btn-logout").addEventListener("click", async () => {
			try {
				await api("/api/logout", {});
			} catch {
				/* ignore */
			}
			location.reload();
		});

		$("#account-chip").addEventListener("click", (e) => {
			e.stopPropagation();
			if (state.accounts.length <= 1) return;
			toggleAccountMenu();
		});
		$("#account-chip").addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				if (state.accounts.length > 1) toggleAccountMenu();
			} else if (e.key === "Escape") {
				closeAccountMenu();
			}
		});
		document.addEventListener("click", (e) => {
			const menu = $("#account-menu");
			if (!menu || menu.hidden) return;
			if (e.target === $("#account-chip") || $("#account-chip").contains(e.target)) return;
			if (menu.contains(e.target)) return;
			closeAccountMenu();
		});
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") closeAccountMenu();
		});

		$("#btn-settings").addEventListener("click", showSettings);

		$("#btn-theme").addEventListener("click", () => {
			const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
			applyTheme(next);
		});

		// 收起/展开（点击切换）；收起态悬停延迟 0.5s 自动展开，移开延迟 0.5s 恢复
		const appView = document.getElementById("app-view");
		let hoverTimer = null;
		let leaveTimer = null;
		const clearHoverTimers = () => {
			clearTimeout(hoverTimer);
			clearTimeout(leaveTimer);
		};

		$("#btn-nav")?.addEventListener("click", () => {
			clearHoverTimers();
			appView.classList.toggle("nav-collapsed");
			if (!appView.classList.contains("nav-collapsed")) appView.classList.remove("hover-expand");
			const scrim = document.getElementById("drawer-scrim");
			if (scrim) scrim.hidden = !isNarrowScreen() || appView.classList.contains("nav-collapsed");
		});

		// 抽屉遮罩：点击关闭抽屉（移动端）
		$("#drawer-scrim")?.addEventListener("click", () => {
			appView.classList.add("nav-collapsed");
			const scrim = document.getElementById("drawer-scrim");
			if (scrim) scrim.hidden = true;
		});

		// 悬停自动展开仅适用于有鼠标指针的设备（触屏由点击抽屉取代）
		if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
			$("#sidebar")?.addEventListener("mouseenter", () => {
				if (!appView.classList.contains("nav-collapsed")) return;
				clearHoverTimers();
				hoverTimer = setTimeout(() => appView.classList.add("hover-expand"), 500);
			});
			$("#sidebar")?.addEventListener("mouseleave", () => {
				const wasExpanded = appView.classList.contains("hover-expand");
				clearHoverTimers();
				if (wasExpanded) {
					leaveTimer = setTimeout(() => appView.classList.remove("hover-expand"), 500);
				}
			});
		}

		$("#compose-btn").addEventListener("click", () => openCompose());
		$("#btn-compose-toolbar")?.addEventListener("click", () => openCompose());

		$("#btn-refresh").addEventListener("click", () => {
			const btn = $("#btn-refresh");
			btn.classList.add("spinning");
			refreshAll()
				.then(() => toast("已刷新", "success"))
				.catch(() => {})
				.finally(() => btn.classList.remove("spinning"));
		});

		$("#btn-back").addEventListener("click", exitSearch);

		$("#btn-load-more").addEventListener("click", () => loadList(state.offset + state.pageSize));

		$("#search-input").addEventListener("keydown", (e) => {
			if (e.key === "Enter") doSearch();
		});
		$("#search-input").addEventListener("input", () => {
			$("#search-clear").hidden = $("#search-input").value === "";
		});
		$("#search-clear").addEventListener("click", exitSearch);

		document.querySelectorAll(".rail-btn[data-jump]").forEach((btn) => {
			btn.addEventListener("click", () => jumpToKind(btn.dataset.jump));
		});

		$("#compose-overlay").addEventListener("click", (e) => {
			if (e.target === $("#compose-overlay")) closeCompose();
		});
		$("#compose-close").addEventListener("click", closeCompose);
		$("#compose-cancel").addEventListener("click", closeCompose);
		$("#compose-form").addEventListener("submit", (e) => {
			e.preventDefault();
			submitCompose();
		});

		$("#attachment-input").addEventListener("change", async (e) => {
			const files = Array.from(e.target.files || []);
			e.target.value = "";
			for (const file of files) {
				if (file.size > 25 * 1024 * 1024) {
					toast(`附件 ${file.name} 超过 25MB 限制`, "error");
					continue;
				}
				const dataBase64 = await fileToBase64(file);
				state.composeAttachments.push({
					filename: file.name,
					contentType: file.type || "application/octet-stream",
					size: file.size,
					dataBase64,
				});
			}
			renderComposeAttachments();
		});

		document.addEventListener("keydown", (e) => {
			const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
			if (e.key === "Escape") {
				if (!$("#compose-overlay").hidden) closeCompose();
				return;
			}
			if (typing) return;
			if (e.key === "c" || e.key === "n") openCompose();
			if (e.key === "r") {
				refreshAll().then(() => toast("已刷新", "success")).catch(() => {});
			}
		});
	}

	function fileToBase64(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = String(reader.result || "");
				resolve(result.slice(result.indexOf(",") + 1));
			};
			reader.onerror = () => reject(new Error("读取文件失败"));
			reader.readAsDataURL(file);
		});
	}

	function fileToDataUrl(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ""));
			reader.onerror = () => reject(new Error("读取文件失败"));
			reader.readAsDataURL(file);
		});
	}

	/* ---------------- init ---------------- */
	async function loadFolders() {
		const data = await api("/api/folders");
		state.folders = data.folders || [];
		const inbox = state.folders.find((f) => f.kind === "inbox");
		if (inbox && !state.currentFolder) state.currentFolder = inbox.name;
		renderFolders();
	}

	/* ---------------- PWA ---------------- */
	function registerServiceWorker() {
		if (!("serviceWorker" in navigator)) return;
		navigator.serviceWorker.register("/sw.js").catch(() => {
			/* 注册失败不影响应用（如非安全上下文） */
		});
	}

	/* ---------------- 登录页安全配置（Turnstile 人机验证） ---------------- */
	function resetTurnstile() {
		window.__cfqmTurnstileToken = "";
		if (window.turnstile && window.__cfqmTurnstileWidgetId != null) {
			try {
				window.turnstile.reset(window.__cfqmTurnstileWidgetId);
			} catch {
				/* ignore */
			}
		}
	}

	function renderTurnstile(siteKey) {
		const box = $("#turnstile-box");
		box.hidden = false;
		const render = () => {
			if (!window.turnstile) return;
			if (window.__cfqmTurnstileWidgetId != null) {
				resetTurnstile();
				return;
			}
			window.__cfqmTurnstileWidgetId = window.turnstile.render(box, {
				sitekey: siteKey,
				callback: (token) => {
					window.__cfqmTurnstileToken = token;
				},
				"expired-callback": () => {
					window.__cfqmTurnstileToken = "";
				},
				"error-callback": () => {
					window.__cfqmTurnstileToken = "";
					return true;
				},
				theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
			});
		};
		if (window.turnstile) {
			render();
			return;
		}
		if (document.getElementById("turnstile-script")) return;
		const s = document.createElement("script");
		s.id = "turnstile-script";
		s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		s.async = true;
		s.defer = true;
		s.onload = render;
		document.head.appendChild(s);
	}

	async function loadAuthConfig() {
		try {
			const cfg = await api("/api/config");
			if (cfg.totpEnabled) $("#login-totp-field").hidden = false;
			if (cfg.turnstileSiteKey) renderTurnstile(cfg.turnstileSiteKey);
		} catch {
			/* 配置加载失败不阻塞登录（后端会兜底校验） */
		}
	}

	async function init() {
		bindEvents();
		registerServiceWorker();
		loadAuthConfig();
		if (window.innerWidth < 900) {
			document.getElementById("app-view")?.classList.add("nav-collapsed");
		}
		try {
			const me = await api("/api/me");
			state.account = me;
			showApp();
			await refreshAll();
			// PWA 快捷方式：/?compose=1 直接打开写邮件
			if (new URLSearchParams(location.search).get("compose") === "1") {
				openCompose();
			}
		} catch {
			showLogin();
		}
	}

	init();
})();
