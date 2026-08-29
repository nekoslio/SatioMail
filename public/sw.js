/* SatioMail Service Worker
   - 静态资源：缓存优先 + 后台更新（stale-while-revalidate）
   - 页面导航：网络优先，失败回退缓存的应用壳
   - /api/*：一律直连网络，绝不缓存邮件数据
   - 更新：改版本号 CACHE 即可让所有客户端换新缓存 */
const CACHE = "satiomail-v3";
const PRECACHE = [
	"/",
	"/app.css",
	"/app.js",
	"/manifest.webmanifest",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
	"/icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return; // 跨域直连
	if (url.pathname.startsWith("/api/")) return; // 邮件数据永不缓存

	// 页面导航：网络优先，离线回退应用壳
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(CACHE).then((cache) => cache.put("/", copy));
					return res;
				})
				.catch(() => caches.match("/")),
		);
		return;
	}

	// 其余同源静态资源：缓存优先 + 后台更新
	event.respondWith(
		caches.match(req).then((cached) => {
			const network = fetch(req)
				.then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((cache) => cache.put(req, copy));
					}
					return res;
				})
				.catch(() => cached);
			return cached || network;
		}),
	);
});
