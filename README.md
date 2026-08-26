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

### v3 (this update — fixes for lichess live games + Replit signup)
- **`X-Proxy-Origin` header on every fetch/XHR** so the server knows what
  the "real" page origin is. Without this, the server can't tell a
  cross-origin request (Replit → identitytoolkit.googleapis.com) from a
  same-origin one and ends up sending the wrong `Origin` header to the
  target — which breaks Firebase's CORS preflight and silently fails
  Replit signup.
- **`__porigin` query param on WebSocket/EventSource URLs** for the same
  reason. Browsers don't allow custom headers on WebSocket, so we
  smuggle the page origin via the URL. The server reads it, sets the
  upstream `Origin` to the page origin (e.g. `lichess.org` for a WS to
  `socket3.lichess.org`), and strips `__porigin` so it doesn't leak
  upstream.
- **`Sec-Fetch-Site` is now correctly computed**: `same-origin` if the
  page origin matches the target origin, `cross-site` otherwise.
  Previously it was hardcoded to `same-origin` which made all cross-
  origin requests look wrong to the target.
- **`Origin` header is now correctly set**: same-origin requests get
  `Origin: <target>` (looks same-origin to the target), cross-origin
  requests get `Origin: <page>` (matches the target's CORS allowlist,
  e.g. Firebase's allowlist for identitytoolkit contains the page
  origin like `replit.com`, not the API's own origin).
- **CSRF-looking cookies pass through to the browser** so site JS can
  read them out of `document.cookie` and put them in `X-CSRF-Token` /
  `X-XSRF-TOKEN` headers. Heuristic: cookie names matching
  `/csrf|xsrf|_token|token|nonce/i` get a duplicate Set-Cookie sent to
  the browser, scoped to `/p/<encoded>/`, with `Domain=`, `Secure`,
  `HttpOnly`, and `SameSite=None` stripped so the browser accepts them
  on the proxy host. The server-side jar still stores the canonical
  copy for upstream delivery.
- **Cookie jar unaffected**: still keyed by target domain for proper
  subdomain-aware delivery on upstream requests (so a session cookie
  set by lichess.org with `Domain=lichess.org` is sent on subsequent
  requests to socket3.lichess.org).

### v2
- **Crash fix**: `throttle.release()` was calling `this._state.get()` on
  what was actually a method, not the state Map. The first response
  completion crashed the server. Fixed.
- **`accept-encoding`**: dropped `zstd` (Node can't decode it natively).
- **Location / Refresh / Link headers are now rewritten** so a target's
  302 redirect (e.g. `http://lichess.org` → `https://lichess.org`) no
  longer escapes the proxy.
- **`WebSocket` and `EventSource` constructors patched client-side** so
  sites that build their WS/SSE URLs dynamically in JS (lichess) stay
  inside the proxy.
- **`content-encoding` / `content-length` stripped from rewritten
  responses** to avoid the client getting a decoded body with mismatched
  headers.
- **`apexOf` helper** in `lib/rewrite.js` for clean subdomain matching.

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
