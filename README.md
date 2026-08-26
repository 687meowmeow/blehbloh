# blehbloh

A server-side web proxy with realistic browser fingerprinting, server-side
cookie management, per-origin request throttling, and full URL rewriting
(including subdomains) so sites that fan out to multiple subdomains — like
lichess.org + socket.lichess.org — work end-to-end.

## Quick start

```bash
npm install
npm start
# visit http://localhost:3000 and enter any URL
```

## What changed (vs. the original simple proxy)

- **Realistic browser fingerprint**: outbound requests now carry a
  current Chrome User-Agent, `sec-ch-ua` client hints, `Accept-Language`,
  `Accept-Encoding`, and matching `Sec-Fetch-*` context headers computed
  per resource type. Detectors that profile headers see a real browser.
- **Proxy-leak header stripping**: `X-Forwarded-*`, `Via`, `Forwarded`,
  `CF-*` and friends are removed from outgoing requests so the target
  can't tell it's being proxied.
- **Server-side cookie jar**: cookies are stored on the server, indexed
  by domain, so a session cookie set by lichess.org with
  `Domain=lichess.org` is sent on subsequent requests to
  socket.lichess.org too. This is what makes WebSocket-based features
  (live games, lobby, etc.) actually authenticate.
- **Per-origin request throttle**: a configurable gate limits the number
  of concurrent in-flight requests per origin and enforces a minimum
  spacing between request starts, so the proxy doesn't fire requests
  like a scraper. Tunable via env vars (see below).
- **Subdomain-aware URL rewriting**: `https://socket.lichess.org/foo` is
  rewritten to `/p/<base64(https://socket.lichess.org)>/foo` — its own
  proxy prefix, not the apex's. Each subdomain is treated as a separate
  origin so cookies and routing stay correct.
- **Client-side patch script**: every proxied HTML document gets a
  `<base>` tag plus an injected `proxy-client.js` that patches
  `history.pushState`/`replaceState`, `fetch()`, `XMLHttpRequest.open()`,
  `window.open()`, `location.assign`/`location.replace`, and uses a
  `MutationObserver` to rewrite `href`/`src` on dynamically inserted
  elements. Runtime-generated URLs stay inside the proxy.
- **WebSocket handshake fixups**: the upgrade handler now attaches
  server-managed cookies, sets a realistic User-Agent, and rewrites the
  `Origin` header to the target origin so the target accepts the
  handshake.
- **Browser-like UI**: home page now has back/forward buttons and
  reflects the currently-proxied URL in the address bar.

## Configuration (env vars)

| Var | Default | What it does |
|-----|---------|-------------|
| `PORT` | `3000` | Listen port |
| `THROTTLE_MAX_CONCURRENT` | `4` | Max simultaneous in-flight requests per origin |
| `THROTTLE_MIN_SPACING_MS` | `180` | Min ms between request starts per origin |

To make it slower / more human-feeling:

```bash
THROTTLE_MAX_CONCURRENT=2 THROTTLE_MIN_SPACING_MS=500 npm start
```

## Layout

```
blehbloh/
├── server.js              # main Express server + http-proxy-middleware wiring
├── lib/
│   ├── fingerprint.js     # realistic UA / sec-ch-ua / Sec-Fetch-* header builder
│   ├── throttle.js        # per-origin concurrent + spacing gate
│   ├── cookieJar.js       # server-side, subdomain-aware cookie storage
│   └── rewrite.js         # URL + body rewriting (apex + subdomains + ws(s))
└── public/
    ├── index.html         # home / address bar UI
    └── proxy-client.js    # injected into every proxied page; patches browser APIs
```

## Known limitations

- **TLS fingerprint (JA3/JA4)** is still Node's, not Chrome's. Sites that
  inspect TLS fingerprint (e.g. Cloudflare's stricter tiers) may still
  detect the proxy. To fully match, you'd need a tool like
  `curl-impersonate` or a custom TLS library.
- **Direct `location.href = "https://target/..."` assignments** can't be
  intercepted (the `location` object is non-configurable). The
  client-side script catches `location.assign`, `location.replace`,
  `history.pushState/replaceState`, `fetch`, `XHR`, `window.open`, and
  click events on dynamically-added anchors — which covers the vast
  majority of real-world navigation, but a page that does
  `location.href = "https://lichess.org/foo"` directly will still
  escape the proxy.
- **Service Workers** are stripped along with CSP (we have to, otherwise
  they'd load JS from the original origin). PWA-style offline caching
  won't work through the proxy.
- **Response bodies are buffered** in memory for rewriting. Fine for
  normal web pages; for very large binary downloads this would be a
  memory hog (the original code has the same limitation).

## Changelog

### v4 (this update — fundamental fixes for "browser-like experience")
This is a big refactor. The previous versions were patching symptoms;
this one fixes the underlying architecture so the proxy behaves the way
a real browser does.

- **Streaming responses no longer buffered.** Replaced HPM's
  `responseInterceptor` (which buffers the entire response body before
  calling the rewrite callback — breaks SSE / long-poll / chunked text)
  with a custom `onProxyRes` handler that pipes streaming responses
  through directly and only buffers the body when we actually need to
  rewrite (HTML / CSS / JS / JSON). Lichess uses long-polling for some
  features; this fixes the "lobby never updates" symptom.
- **Brotli decompression fixed.** `zlib.createUnzip()` does NOT auto-
  detect brotli — Node needs `createBrotliDecompress()` explicitly. v3
  advertised `accept-encoding: br` but couldn't decode it, so any
  brotli-encoded response body came back empty (which is why Replit
  "wouldn't even load" — its home page is brotli-encoded). Now: gzip
  → `createUnzip()`, deflate → `createUnzip()`, br →
  `createBrotliDecompress()`.
- **ALL cookies mirrored to the browser** (not just CSRF-named ones).
  Site JS often reads session info out of `document.cookie` — for
  analytics, A/B tests, feature flags, and (importantly) CSRF tokens.
  v3 only mirrored CSRF-named cookies; v4 mirrors every cookie the
  upstream sets, scoped to `/p/<encoded>/` with safe attributes
  (`Domain`/`HttpOnly`/`Secure` stripped so the browser accepts it on
  the proxy host and JS can read it).
- **Browser-sent cookies sync back to the server jar.** When JS sets
  `document.cookie = "session=xyz"`, the browser stores it scoped to
  the proxy host. On the next request, the browser sends it; v4's
  `buildOutboundHeaders` syncs it into the server-side jar so the
  upstream actually receives it. Before v4, JS-set cookies were
  silently dropped.
- **Absolute-path URLs rewritten.** `<base href="/p/<encoded>/">` only
  affects relative URLs — absolute paths (`href="/login"`,
  `fetch('/api/foo')`) ignore the base tag and go straight to the
  proxy host (404). v4 rewrites `/foo` to `/p/<encoded>/foo` both
  server-side (in HTML attributes via `URL_ATTR_RE`) and client-side
  (in the `rewriteUrl` helper used by `fetch`/`XHR`/etc.). This was
  probably the single biggest "doesn't load" cause.
- **Hostname regex hardened.** Added `(?![a-zA-Z0-9.-])` negative
  lookahead so `https://replit.com.evil.com` does NOT match
  `replit.com` (it would have been rewritten to
  `/p/<encoded>/.evil.com` before). Also added optional `:port` so
  `https://lichess.org:8443` matches correctly.
- **Existing `<base>` tags removed before injecting ours.** The
  HTML spec says the LAST `<base>` wins; if a page already has
  `<base href="https://other.com/">`, my injection would have been
  overridden and relative URLs would break.
- **Cookie jar `syncFromBrowser` method.** Lets the jar absorb JS-set
  cookies and merge with server-set cookies.

### v3
- **`X-Proxy-Origin` header** on every fetch/XHR so the server knows what
  the "real" page origin is. Without this, the server can't tell a
  cross-origin request (Replit → identitytoolkit.googleapis.com) from a
  same-origin one and ends up sending the wrong `Origin` header to the
  target — which breaks Firebase's CORS preflight and silently fails
  Replit signup.
- **`__porigin` query param** on WebSocket/EventSource URLs for the same
  reason (browsers don't allow custom headers on WebSocket, so we
  smuggle the page origin via the URL).
- **`Sec-Fetch-Site` correctly computed**: `same-origin` if page matches
  target, `cross-site` otherwise (was hardcoded to `same-origin`).
- **`Origin` header correctly set**: same-origin → `<target>`,
  cross-origin → `<page>` (matches Firebase's CORS allowlist).

### v2
- Crash fix in `throttle.release()` (was calling `this._state.get()`
  on a method, not the Map).
- Dropped `zstd` from `accept-encoding` (Node can't decode it).
- Location / Refresh / Link headers rewritten.
- WebSocket + EventSource constructors patched client-side.
- `content-encoding` / `content-length` stripped from rewritten responses.

### v1 (initial)
- Realistic browser fingerprint (UA, sec-ch-ua, Sec-Fetch-*).
- Server-side, subdomain-aware cookie jar.
- Per-origin request throttle.
- Subdomain-aware URL rewriting.
- Client-side patches for history, fetch, XHR, window.open, location.
- Proxy-leak header stripping.
- WebSocket upgrade handshake fixups (UA, Origin, cookies).

## How to test against lichess

1. `npm install && npm start`
2. Visit `http://localhost:3000`
3. Enter `https://lichess.org` and press Go.
4. You should land on lichess with a normal-looking UI, real-time
   lobby/game websockets should connect (visible in the browser devtools
   Network tab filtered to WS — the WS URLs will be
   `ws://localhost:3000/p/<encoded socket.lichess.org>/...`).
