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
const zlib = require('zlib');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { encodeOrigin, decodeOrigin, escapeRegex, rewriteSingleUrl, rewriteTextBody, injectIntoHtml } = require('./lib/rewrite');
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

// Headers we strip from the upstream response (we either recompute them or
// they block our same-origin rewriting from working).
const STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'strict-transport-security',
  'connection',         // hop-by-hop
  'keep-alive',         // hop-by-hop
  'transfer-encoding',  // we send either chunked or content-length, not both
]);

// URL-bearing response headers that need rewriting to keep the browser
// inside the proxy.
function rewriteUrlHeader(name, value, targetUrl, proxyHost) {
  if (!value) return value;
  if (name === 'location') {
    return rewriteSingleUrl(value, targetUrl, proxyHost);
  }
  if (name === 'refresh') {
    // Refresh: 5; url=https://target/foo
    return value.replace(
      /url=(https?:\/\/[^;]+)/i,
      (m, u) => 'url=' + rewriteSingleUrl(u, targetUrl, proxyHost)
    );
  }
  if (name === 'link') {
    // Link: <https://target/foo>; rel=preload
    return value.replace(
      /<([^>]+)>/g,
      (m, u) => '<' + rewriteSingleUrl(u, targetUrl, proxyHost) + '>'
    );
  }
  return value;
}

// Mirror an upstream Set-Cookie to the browser, scoped to /p/<encoded>/.
// - Strip Domain= (we can't set it to the target's domain).
// - Strip Secure (the proxy may be HTTP; if HTTPS, we re-add it below).
// - Strip SameSite (the proxy is same-origin from the browser's view, so
//   default Lax is fine).
// - Strip HttpOnly (we want JS to be able to read document.cookie for
//   CSRF-token flows).
// - Scope to /p/<encoded>/ so cookies don't leak between proxy targets.
function mirrorSetCookie(raw, prefix, isHttpsProxy) {
  let rewritten = raw
    .replace(/;\s*Domain=[^;]+/gi, '')
    .replace(/;\s*SameSite=[^;]+/gi, '')
    .replace(/;\s*Secure/gi, '')
    .replace(/;\s*HttpOnly/gi, '');
  rewritten += '; Path=' + prefix + '/';
  if (isHttpsProxy) rewritten += '; SameSite=None; Secure';
  return rewritten;
}

// Custom response handler. We use `selfHandleResponse: true` and handle the
// response ourselves instead of using HPM's `responseInterceptor` because
// the latter buffers the entire response body before calling our callback,
// which breaks streaming responses (SSE, NDJSON, long-poll, chunked text).
//
// For each response we:
//   1. Mirror Set-Cookie to the browser (all cookies, scoped to proxy path)
//      and also store in the server-side jar.
//   2. Strip headers that block same-origin rewriting (CSP, X-Frame-Options,
//      COOP/COEP/CORP, HSTS, hop-by-hop headers).
//   3. Rewrite URL-bearing headers (Location, Refresh, Link).
//   4. Decide: stream through (binary, SSE) or buffer + rewrite (text).
//   5. For text: decompress (gzip/deflate/br), collect, rewrite URLs + inject
//      <base>+script for HTML, re-send without content-encoding/length.
function makeOnProxyRes(targetUrl, encoded, prefix) {
  return function onProxyRes(proxyRes, req, res) {
    // Determine if our connection to the browser is HTTPS (affects cookie
    // SameSite/Secure attributes we set on mirrored Set-Cookie).
    const isHttpsProxy = !!(req.connection && req.connection.encrypted)
      || req.headers['x-forwarded-proto'] === 'https';

    // 1. Set-Cookie handling: store in jar + mirror to browser.
    const setCookie = proxyRes.headers['set-cookie'];
    if (setCookie) {
      cookies.set(setCookie, targetUrl.hostname);
      const mirrored = setCookie.map((raw) => mirrorSetCookie(raw, prefix, isHttpsProxy));
      // We'll set this on `res` after copying other headers.
      proxyRes.headers['__mirrored_set_cookie'] = mirrored;
      delete proxyRes.headers['set-cookie'];
    }

    // 2. Status code.
    res.statusCode = proxyRes.statusCode || 200;

    // 3. Copy + rewrite headers (skip ones we strip; rewrite URL-bearing ones).
    for (const [name, value] of Object.entries(proxyRes.headers)) {
      if (name === '__mirrored_set_cookie') continue;
      const lower = name.toLowerCase();
      if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
      if (lower === 'content-encoding' || lower === 'content-length') {
        // We'll recompute these for rewritten text; for binary/streaming
        // they'll be handled below.
        continue;
      }
      const rewritten = rewriteUrlHeader(lower, value, targetUrl, req.headers.host);
      try { res.setHeader(name, rewritten); } catch (e) {}
    }

    // Apply mirrored Set-Cookie (after other headers, in case removing then
    // re-adding the header is needed).
    if (proxyRes.headers['__mirrored_set_cookie']) {
      try { res.setHeader('set-cookie', proxyRes.headers['__mirrored_set_cookie']); } catch (e) {}
      delete proxyRes.headers['__mirrored_set_cookie'];
    }

    // 4. Decide: stream through (binary, SSE) or buffer + rewrite (text).
    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const isHtml  = contentType.includes('text/html');
    const isJs    = contentType.includes('javascript') || contentType.includes('ecmascript');
    const isCss  = contentType.includes('text/css');
    const isJson = contentType.includes('json') && !contentType.includes('stream');
    const isText = isHtml || isJs || isCss || isJson || contentType.includes('text/');
    const isStreaming = contentType.includes('text/event-stream')
      || contentType.includes('application/x-ndjson')
      || contentType.includes('application/stream+json')
      || contentType.includes('application/grpc-web');

    if (!isText || isStreaming) {
      // Stream through directly (binary, fonts, images, video, SSE, NDJSON).
      // Preserve original content-length/content-encoding.
      const enc = proxyRes.headers['content-encoding'];
      const len = proxyRes.headers['content-length'];
      if (enc) try { res.setHeader('content-encoding', enc); } catch (e) {}
      if (len) try { res.setHeader('content-length', len); } catch (e) {}
      proxyRes.pipe(res);
      return;
    }

    // 5. For text: decompress, collect, rewrite, send.
    const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
    if (process.env.DEBUG_PROXY) {
      console.error(`[debug] ${req.method} ${req.path} content-type=${contentType} encoding=${encoding} status=${proxyRes.statusCode}`);
    }
    let stream = proxyRes;
    if (encoding.includes('br')) {
      // Broton is NOT auto-detected by createUnzip -- we need a separate
      // decompressor for it.
      stream = proxyRes.pipe(zlib.createBrotliDecompress());
    } else if (encoding.includes('gzip') || encoding.includes('deflate')) {
      // createUnzip auto-detects gzip vs deflate based on the buffer.
      stream = proxyRes.pipe(zlib.createUnzip());
    }
    if (stream !== proxyRes) {
      stream.on('error', (e) => {
        console.error(`[proxy ${targetUrl.origin}] decompress error on ${req.path}:`, e.message);
        if (!res.headersSent) res.end();
        else res.end();
      });
    }

    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        let body = buf.toString('utf8');
        body = rewriteTextBody(body, targetUrl, req.headers.host, encoded);
        if (isHtml) {
          body = injectIntoHtml(body, encoded, targetUrl.origin);
        }
        // Body changed: strip content-encoding (we decoded), recompute length.
        try { res.removeHeader('content-encoding'); } catch (e) {}
        const outBuf = Buffer.from(body, 'utf8');
        try { res.setHeader('content-length', outBuf.length); } catch (e) {}
        res.end(outBuf);
      } catch (e) {
        console.error(`[proxy ${targetUrl.origin}] rewrite error on ${req.path}:`, e.message);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain');
          res.end('Proxy rewrite error: ' + e.message);
        } else {
          res.end();
        }
      }
    });
    stream.on('error', (e) => {
      console.error(`[proxy ${targetUrl.origin}] stream error on ${req.path}:`, e.message);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'text/plain');
        res.end('Proxy stream error: ' + e.message);
      } else {
        res.end();
      }
    });
  };
}

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
    pathRewrite: (p) => (p.startsWith(prefix) ? p.slice(prefix.length) || '/' : p),

    onProxyReq: (proxyReq, req, res) => {
      // Cookies from our server-side jar (subdomain-aware). buildOutboundHeaders
      // will also sync browser-sent cookies back into the jar so JS-set cookies
      // flow through.
      const cookieHeader = cookies.get(targetUrl.hostname, req.path || '/', isHttps);
      const headers = buildOutboundHeaders(req, targetUrl, prefix, cookieHeader, cookies);
      for (const [k, v] of Object.entries(headers)) {
        try { proxyReq.setHeader(k, v); } catch (e) { /* some headers are read-only */ }
      }
      // Drop anything we didn't override above but that we definitely don't
      // want to leak.
      for (const name of ['x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-forwarded-server','x-real-ip','via','forwarded','cf-connecting-ip','cf-ipcountry','cf-ray','cf-visitor','x-cluster-client-ip']) {
        try { proxyReq.removeHeader(name); } catch (e) {}
      }
    },

    onProxyRes: makeOnProxyRes(targetUrl, encoded, prefix),

    onError: (err, req, res) => {
      console.error(`[proxy ${targetUrl.origin}] error on ${req.path}:`, err.message);
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
  console.log(`  Cookies: server-side jar (subdomain-aware) + browser mirror (all cookies)`);
});

// WebSocket upgrade requests bypass Express routing entirely; match the
// path back to the right cached proxy target and let http-proxy-middleware
// handle the upgrade.
server.on('upgrade', (req, socket, head) => {
  // Parse the URL so we can extract the __porigin query param the client
  // side attached (see proxy-client.js PatchedWebSocket).
  let reqUrl;
  try { reqUrl = new URL(req.url, 'http://dummy'); }
  catch (err) { socket.destroy(); return; }

  const m = reqUrl.pathname.match(/^\/p\/([^/]+)(.*)$/);
  if (!m) { socket.destroy(); return; }
  const encoded = m[1];
  const innerPath = m[2] || '/';

  // Pull __porigin out of the query (and reconstruct the upstream URL).
  let pageOrigin = null;
  try {
    const porigin = reqUrl.searchParams.get('__porigin');
    if (porigin) pageOrigin = Buffer.from(porigin, 'base64url').toString('utf8');
  } catch (e) { /* ignore */ }

  // Strip __porigin from the URL so it doesn't get forwarded to the target.
  reqUrl.searchParams.delete('__porigin');
  req.url = '/p/' + encoded + innerPath + (reqUrl.search || '');

  let entry;
  try { entry = getOrCreateProxy(encoded); }
  catch (err) { socket.destroy(); return; }

  // Strip leak headers on the upgrade.
  for (const name of ['x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','via','forwarded','cf-connecting-ip','cf-ipcountry','cf-ray','cf-visitor']) {
    try { delete req.headers[name]; } catch (e) {}
  }

  // Sync browser-sent cookies (if any) into the jar, then read jar cookies
  // for the WS handshake. (The Cookie header on an upgrade is rare, but
  // some clients do send it.)
  if (req.headers.cookie) {
    cookies.syncFromBrowser(req.headers.cookie, entry.targetUrl.hostname);
  }
  const cookieHeader = cookies.get(entry.targetUrl.hostname, '/', entry.targetUrl.protocol === 'https:');
  if (cookieHeader) req.headers.cookie = cookieHeader;

  // Realistic UA on the WS handshake.
  req.headers['user-agent'] = USER_AGENT;

  // Origin: same-origin -> target origin; cross-origin -> page origin
  // (so the target's CORS allowlist matches).
  if (pageOrigin && pageOrigin !== entry.targetUrl.origin) {
    req.headers['origin'] = pageOrigin;
  } else {
    req.headers['origin'] = entry.targetUrl.origin;
  }

  entry.proxy.upgrade(req, socket, head);
});
