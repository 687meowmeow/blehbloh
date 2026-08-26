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

### v5 (this update — root-cause fixes for images + layout + lichess + replit)
Diagnosed empirically by fetching live lichess.org and replit.com HTML and
running the actual rewriter against them. Found 7 specific bugs:

- **Double-prefix bug on cross-origin absolute URLs (the Replit killer).**
  `<script src="https://cdn.replit.com/_next/foo.js">` was rewritten to
  `/p/<encoded-replit>/p/<encoded-cdn>/_next/foo.js` (double-prefixed).
  The browser requested that, the proxy stripped the outer prefix, forwarded
  `replit.com/p/<encoded-cdn>/_next/foo.js` → 404. EVERY Replit JS chunk
  failed. Fixed: skip-check now recognizes any `/p/<encoded>/` prefix, not
  just the target's own.
- **`<meta http-equiv="Content-Security-Policy">` not stripped (the Lichess
  killer).** Lichess ships CSP as a meta tag (not a header). My rewriter
  rewrote the `wss://socketN.lichess.org` entries to `wss://localhost/p/...`
  but CSP path-matching requires the source's path to end with `/`. The
  rewritten sources don't, so the actual WS URL was rejected. Lobby never
  populated. Fixed: meta CSP tags are now stripped entirely (the response
  CSP header was already stripped).
- **CSS `url('/foo')` never rewritten.** Affected inline `<style>` and
  external `.css` files. `@font-face{src:url('/fonts/x.woff2')}` 404'd
  against the proxy host. Fixed: new `rewriteCssUrls` for text/css content
  + inline `<style>` blocks. Skips `data:`/`blob:`/`#`/`mailto:`.
- **Cross-apex origins not proxied.** `lichess1.org` (lichess's asset CDN,
  separate eTLD+1), `cdn.replit.com`, `reachability.replit.app`,
  `identitytoolkit.googleapis.com` (Firebase) were all left untouched
  because the rewriter only matched the target's own eTLD+1. Result: the
  browser made direct cross-origin requests to these origins, leaking the
  user's real IP and failing CORS. Fixed: the rewriter now proxies ALL
  absolute URLs through `/p/<encoded-of-that-origin>/`. Each origin gets
  its own encoded prefix.
- **`srcset` not in `URL_ATTR_RE`.** Initial-HTML `srcset` was never
  rewritten server-side. Fixed: separate `SRCSET_ATTR_RE` handles
  `srcset`/`imagesrcset`/`data-srcset`.
- **`rewriteSrcset` destroyed Cloudflare URLs by splitting on `,`.**
  Cloudflare's `cdn-cgi/image` URLs contain un-encoded commas
  (`/cdn-cgi/image/width=128,quality=80,format=auto/...`). The naive
  `value.split(',')` fragmented them. Fixed: descriptor-aware scanner
  that only treats a comma as an entry separator if the next non-space
  token looks like a URL start.
- **Absolute paths in HTML attrs not rewritten for `<base>` tag limitation.**
  Per RFC 3986, `<base href="/p/<encoded>/">` does NOT affect absolute
  paths (`/foo`). They were silently 404ing against the proxy host. Already
  fixed in v4, now applied more robustly.

Additional v5 improvements:
- Expanded `ATTRIBS` table in the client-side MutationObserver: added
  `ping`, `imagesrcset`, `imagesizes`, `formaction`, `data-bg`,
  `data-original`, `data-lazy`, `data-lazy-src`, `data-srcset`,
  `data-poster`, `data-share-url`, `data-download-url`, SVG `<use>`,
  SVG `<image>`, `xlink:href`, `track`.
- Initial-document rewrite now runs SYNCHRONOUSLY at script-injection
  time (was on DOMContentLoaded, which was too late for `<head>` elements
  like `<link>` / `<meta>`).
- Inline `style="url(...)"` attributes now rewritten.
- Meta refresh (`<meta http-equiv="refresh" content="0; url=/foo">`)
  now handled.

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
