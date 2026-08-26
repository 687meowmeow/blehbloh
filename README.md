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

## How to test against lichess

1. `npm install && npm start`
2. Visit `http://localhost:3000`
3. Enter `https://lichess.org` and press Go.
4. You should land on lichess with a normal-looking UI, real-time
   lobby/game websockets should connect (visible in the browser devtools
   Network tab filtered to WS — the WS URLs will be
   `ws://localhost:3000/p/<encoded socket.lichess.org>/...`).
