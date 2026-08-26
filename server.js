// Reverse proxy with realistic browser fingerprinting, server-side cookie
// management, per-origin request throttling, and full URL rewriting for
// the target origin and any of its subdomains (so sites like lichess.org
// that fan out to socket.lichess.org / api.lichess.org work end-to-end).
//
// Usage:
//   node server.js            # default: port 3000, throttle 180ms / 4 concurrent
//   PORT=8080 node server.js
//   THROTTLE_MAX_CONCURRENT=2 THROTTLE_MIN_SPACING_MS=500 node server.js
//
// Tunable env vars:
//   PORT                       Proxy listen port (default 3000)
//   THROTTLE_MAX_CONCURRENT    Max in-flight requests per origin (default 4)
//   THROTTLE_MIN_SPACING_MS    Min ms between request starts per origin (default 180)

const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const { encodeOrigin, decodeOrigin, escapeRegex, rewriteTextBody, injectIntoHtml } = require('./lib/rewrite');
const { buildOutboundHeaders, USER_AGENT } = require('./lib/fingerprint');
const { gateFromEnv } = require('./lib/throttle');
const { CookieJar } = require('./lib/cookieJar');

const app = express();
const PORT = process.env.PORT || 3000;

// Per-origin request gate (slow + human-like).
const throttle = gateFromEnv();

// Server-side cookie jar: one jar shared across all targets. Cookies are
// keyed by domain, so a session cookie set by lichess.org with Domain=
// lichess.org is sent on subsequent requests to socket.lichess.org too.
const cookies = new CookieJar();

// Persistent agents so TCP connections to the target are reused across
// requests -- a real browser keeps connections alive, and so should we.
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 60000,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 60000,
  rejectUnauthorized: true,
});

app.use(express.static(path.join(__dirname, 'public')));

// --- proxy middleware cache ------------------------------------------
// One http-proxy-middleware instance per encoded target origin so WebSocket
// upgrade requests (which bypass Express routing) can find the right one.
const proxyCache = new Map();

function getOrCreateProxy(encoded) {
  if (proxyCache.has(encoded)) return proxyCache.get(encoded);

  const target = decodeOrigin(encoded);
  const targetUrl = new URL(target); // throws if invalid
  const prefix = `/p/${encoded}`;
  const isHttps = targetUrl.protocol === 'https:';

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true, // Host header set to target.host (we also set it explicitly below)
    ws: true,
    secure: true,
    selfHandleResponse: true,
    agent: isHttps ? httpsAgent : httpAgent,

    // Preserve the request path after stripping the /p/<encoded>/ prefix.
    // Without this, the proxy would forward /p/<encoded>/api/foo to the
    // target as /p/<encoded>/api/foo and the target would 404.
    pathRewrite: (p) => (p.startsWith(prefix) ? p.slice(prefix.length) || '/' : p),

    // Tweak the outgoing request: replace the fingerprint, strip leaks,
    // attach server-managed cookies, and rewrite Referer / Origin / Host.
    onProxyReq: (proxyReq, req, res) => {
      // Cookies from our server-side jar (subdomain-aware).
      const cookieHeader = cookies.get(targetUrl.hostname, req.path || '/', isHttps);
      const headers = buildOutboundHeaders(req, targetUrl, prefix, cookieHeader);
      for (const [k, v] of Object.entries(headers)) {
        try { proxyReq.setHeader(k, v); } catch (e) { /* some headers are read-only */ }
      }
      // Drop anything we didn't override above but that we definitely don't
      // want to leak.
      for (const name of ['x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-forwarded-server','x-real-ip','via','forwarded','cf-connecting-ip','cf-ipcountry','cf-ray','cf-visitor','x-cluster-client-ip']) {
        try { proxyReq.removeHeader(name); } catch (e) {}
      }
    },

    onProxyRes: responseInterceptor(async (buffer, proxyRes, req, res2) => {
      // 1. Eat Set-Cookie: store into our server-side jar, then strip the
      //    header from the response we forward to the browser. (The browser
      //    would otherwise store cookies scoped to our domain, but that
      //    doesn't help us -- we want them server-side so subdomain-aware
      //    requests can see them.)
      const setCookie = proxyRes.headers['set-cookie'];
      if (setCookie) {
        cookies.set(setCookie, targetUrl.hostname);
        try { res2.removeHeader('set-cookie'); } catch (e) {}
      }

      // 2. Strip headers that block our same-origin rewriting.
      res2.removeHeader('content-security-policy');
      res2.removeHeader('content-security-policy-report-only');
      res2.removeHeader('x-frame-options');
      res2.removeHeader('cross-origin-opener-policy');
      res2.removeHeader('cross-origin-embedder-policy');
      res2.removeHeader('cross-origin-resource-policy');
      res2.removeHeader('permissions-policy');
      res2.removeHeader('strict-transport-security');

      const contentType = proxyRes.headers['content-type'] || '';
      const isText =
        contentType.includes('text/html') ||
        contentType.includes('javascript') ||
        contentType.includes('css') ||
        contentType.includes('json') ||
        contentType.includes('text/');

      if (!isText) return buffer; // images, fonts, video, audio pass through.

      let text = buffer.toString('utf8');

      // 3. Rewrite absolute / protocol-relative / ws(s) URLs in the body.
      text = rewriteTextBody(text, targetUrl, req.headers.host);

      // 4. For HTML, also inject the <base> tag + client-side patch script.
      if (contentType.includes('text/html')) {
        text = injectIntoHtml(text, encoded, targetUrl.origin);
      }

      return text;
    }),

    onError: (err, req, res) => {
      if (res && !res.headersSent) {
        res.status(502).json({ error: 'Proxy error', detail: err.message });
      }
    },
  });

  const entry = { proxy, target, prefix, targetUrl };
  proxyCache.set(encoded, entry);
  return entry;
}

// --- throttling wrapper ---------------------------------------------
// We can't put an async function into Express middleware chain directly
// against the proxy, because http-proxy-middleware streams. Instead, we
// wrap the proxy invocation: acquire the per-origin gate, forward, release
// on response end (or error).
function throttledProxy(entry, req, res, next) {
  const origin = entry.targetUrl.origin;
  let released = false;
  const release = () => {
    if (!released) { released = true; throttle.release(origin); }
  };
  res.on('close', release);
  res.on('finish', release);

  throttle.acquire(origin).then(() => {
    if (released) { release(); return; }
    entry.proxy(req, res, next);
  }).catch(() => {
    release();
    if (!res.headersSent) res.status(500).send('throttle error');
  });
}

// --- routes ----------------------------------------------------------

// Entry point: /go?url=https://example.com redirects into the proxy path.
app.get('/go', (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing "url" query parameter');

  let target;
  try {
    target = raw.match(/^https?:\/\//i) ? raw : 'https://' + raw;
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');

    const origin = parsed.origin;
    const encoded = encodeOrigin(origin);
    const restPath = target.slice(origin.length) || '/';
    res.redirect(`/p/${encoded}${restPath}`);
  } catch (err) {
    res.status(400).send('Invalid URL: ' + err.message);
  }
});

// Everything under /p/<encodedOrigin>/... is proxied to that origin.
app.use('/p/:encoded', (req, res, next) => {
  let entry;
  try {
    entry = getOrCreateProxy(req.params.encoded);
  } catch (err) {
    return res.status(400).send('Invalid proxy target: ' + err.message);
  }
  throttledProxy(entry, req, res, next);
});

const server = app.listen(PORT, () => {
  console.log(`Proxy server running at http://localhost:${PORT}`);
  console.log(`  UA: ${USER_AGENT}`);
  console.log(`  Throttle: max ${process.env.THROTTLE_MAX_CONCURRENT || 4} concurrent, ${process.env.THROTTLE_MIN_SPACING_MS || 180}ms min spacing per origin`);
  console.log(`  Cookies: server-side jar (subdomain-aware)`);
});

// WebSocket upgrade requests bypass Express routing entirely; match the
// path back to the right cached proxy target and let http-proxy-middleware
// handle the upgrade.
server.on('upgrade', (req, socket, head) => {
  const match = req.url.match(/^\/p\/([^/]+)/);
  if (!match) { socket.destroy(); return; }
  try {
    const entry = getOrCreateProxy(match[1]);
    // Strip leak headers on the upgrade too.
    for (const name of ['x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','via','forwarded']) {
      try { delete req.headers[name]; } catch (e) {}
    }
    // Attach cookies for the WebSocket handshake (e.g. lichess session).
    const cookieHeader = cookies.get(entry.targetUrl.hostname, '/', entry.targetUrl.protocol === 'https:');
    if (cookieHeader) req.headers.cookie = cookieHeader;
    // Realistic UA on the WS handshake.
    req.headers['user-agent'] = USER_AGENT;
    req.headers['origin'] = entry.targetUrl.origin;
    entry.proxy.upgrade(req, socket, head);
  } catch (err) {
    socket.destroy();
  }
});
