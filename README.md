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

### v6 (this update — JS AST rewriter + location emulation)
This is the big architectural fix that production proxies (Ultraviolet,
Corrosion) have and we didn't. Replit was uninteractable and lichess's
center panel was missing because the JS AST rewriter was missing.

- **JS AST rewriter** (`lib/jsRewrite.js`): parses every JS bundle with
  acorn, walks the AST, and rewrites reads/writes of `location`,
  `parent`, `top` to go through `$proxyGet$` / `$proxySet$` globals
  that return an emulated location object. `location.href` becomes
  `$proxyGet$(window, "location").href`. `window.location = "/foo"`
  becomes `$proxySet$(window, "location", "/foo", "=")`. Object keys,
  function params, var declarations, and member accesses on non-
  window objects are correctly NOT rewritten. Function/arrow/destructuring
  param shadowing is handled by a scope-tracking first pass.
- **Location emulation** (in `public/proxy-client.js`): a plain
  object with `href`/`origin`/`pathname`/etc. getters that return the
  TARGET's URL parts (parsed by unwrapping the proxy prefix from the
  real `location.href`). Setters navigate via `window.location.href =
  rewriteUrl(...)`. This is what `$proxyGet$(window, "location")`
  returns to the page's JS.
- **`$proxyGet$`/`$proxySet$`/`$proxyCall$m` globals** installed on
  `window`. `$proxyGet$(window, "location")` returns the location
  emulation; `$proxySet$(window, "location", "url", "=")` navigates via
  the proxy; other reads/writes fall through to the real property.
- **`history.pushState`/`replaceState` now call `updateLocationEmulation`
  after** so that subsequent reads of `location.pathname` reflect the
  new path. SPA routers (Next.js `useRouter`, scalajs-react) read
  `location.pathname` to determine which route to render.
- **`popstate` listener** updates the emulation on back/forward.
- **`document.URL` / `documentURI` overrides** return the target's URL
  (was returning the proxy URL).
- **`Node.prototype.baseURI` override** returns the target origin.
- **`window.origin` override** (window.origin IS configurable, unlike
  window.location).
- **Anchor click handler removed.** The capture-phase click listener
  was desyncing React 18's synthetic event system (it walks the DOM
  during the click handler and gets confused if attributes change
  mid-event). Replaced with `HTMLAnchorElement.prototype.href` descriptor
  override + sidecar attribute pattern (`__proxy-href`): when JS sets
  `el.href = "/foo"`, we stash `/foo` under `__proxy-href` and set the
  actual href to `rewriteUrl("/foo")`. `getAttribute('href')` returns
  the sidecar; the browser navigates the proxied URL. This is the
  pattern Corrosion uses.
- **Inline `<script>` blocks** now get the JS AST rewriter applied
  (was only being applied to external .js files).
- **Absolute https?:// URLs in inline scripts are NO LONGER rewritten**
  (only absolute paths /foo are). This preserves origin string
  comparisons like `if (location.origin === "https://replit.com")`
  — both sides now read the same target origin. The client-side
  `fetch()`/`XHR` patches catch URLs used as fetch arguments at runtime.

### v5
- Double-prefix bug on cross-origin absolute URLs (the Replit killer):
  `<script src="https://cdn.replit.com/_next/foo.js">` was getting
  `/p/<enc-replit>/p/<enc-cdn>/_next/foo.js`. Fixed.
- `<meta http-equiv="Content-Security-Policy">` stripped (the Lichess
  killer): CSP path-matching rejected the proxied WS URLs.
- CSS `url('/foo')` rewriter added for text/css + inline `<style>`.
- Cross-apex origins proxied: lichess1.org, cdn.replit.com,
  identitytoolkit.googleapis.com (Firebase) all get their own encoded
  prefix. Replaces the old "only match target eTLD+1" logic.
- srcset/imagesrcset handled separately with descriptor-aware splitter
  (Cloudflare's cdn-cgi/image URLs contain commas).
- SVG `<use>`/`<image>`/`xlink:href`, meta refresh, `data-bg`/
  `data-original`/`data-lazy-src`, inline `style="url(...)"` attributes.

### v4
- Streaming responses no longer buffered (custom `onProxyRes`).
- Broton decompression fixed (`createBrotliDecompress`).
- ALL cookies mirrored to browser.
- Browser-set cookies sync back to server jar.
- Hostname regex hardened.
- Existing `<base>` tags removed before injecting ours.

### v3
- `X-Proxy-Origin` header on every fetch/XHR.
- `__porigin` query param on WebSocket/EventSource URLs.
- `Sec-Fetch-Site` correctly computed.
- `Origin` header correctly set.

### v2
- Crash fix in `throttle.release()`.
- Dropped `zstd` from `accept-encoding`.
- Location / Refresh / Link headers rewritten.
- WebSocket + EventSource constructors patched client-side.

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
