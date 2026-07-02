// WADACHI — smart service worker (auto-update edition)
//
// 設計方針:
// ・HTML / CSS / JS / JSON / マニフェスト → Network First で常に最新を取得
//   (ネットワーク失敗時のみキャッシュにフォールバック = オフライン対応)
// ・外部ライブラリ (Leaflet) → Cache First で高速化
// ・OSM タイル → Network First with cache fallback
//
// GitHub Pages にファイルをアップロードすると、ブラウザ再読み込みだけで
// 即座に最新版が反映されるので、キャッシュ番号の手動更新は不要。

const CACHE = `wadachi-v4.0.0-${Date.now()}`;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/* ─────────── INSTALL ─────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

/* ─────────── ACTIVATE ─────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ─────────── FETCH ─────────── */
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // OpenStreetMap タイル: Network First, fallback to cache
  if (url.host.includes('tile.openstreetmap.org')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // 同一オリジンのアプリファイルを判定
  // ルート URL '/' や '/timeAttacker/' も含む (拡張子なしのパスは HTML 扱い)
  const isSameOrigin = url.origin === self.location.origin;
  const path = url.pathname;
  const isAppFile = isSameOrigin && (
    path === '/' ||
    path.endsWith('/') ||
    path.endsWith('.html') ||
    path.endsWith('.css') ||
    path.endsWith('.js') ||
    path.endsWith('.json')
  );

  if (isAppFile) {
    // Network First: ネットワーク成功 → キャッシュ更新 + 応答
    //                ネットワーク失敗 → キャッシュ応答 (オフライン対応)
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE)
              .then(cache => cache.put(request, clone))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // それ以外 (画像・外部ライブラリ等): Cache First
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
