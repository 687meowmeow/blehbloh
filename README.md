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

### v10 (this update — worker bootstrap + UV-parity patches)
Audited Ultraviolet's source (`/tmp/uv-core/`) and found 12 more patches +
the worker bootstrap system that UV has and we didn't. All implemented.

- **Worker bootstrap system** (the biggest gap): server detects worker
  requests via `Sec-Fetch-Dest: worker / shared-worker / service-worker /
  audio-worklet / paint-worklet` and prepends a bootstrap that calls
  `importScripts('/proxy-worker-bootstrap.js')` and sets
  `self.__proxyWorkerConfig`. The bootstrap patches the worker's
  `self.fetch`, `XMLHttpRequest.open`, `self.importScripts`, `self.WebSocket`,
  `self.EventSource`, and `self.WorkerLocation` so the worker's
  `fetch('/api/foo')` goes through the proxy instead of 404ing on the
  proxy origin. Without this, any site that uses workers for non-trivial
  work (lichess chess engine, Firebase auth workers, monaco-editor,
  Figma, code sandbox) silently breaks.
- **`DOMParser.prototype.parseFromString`** override: rewrites URLs in
  HTML strings parsed by `new DOMParser().parseFromString(htmlStr, 'text/html')`.
  React's component testing utilities and Apollo's link parser use this.
- **`new Function("...")` override**: rewrites URL strings in the body
  so `new Function("return fetch('/foo')")()` works through the proxy.
  Catches eval-based template compilers (Vue 2 template compiler).
- **`window.eval` override**: rewrites URL strings in the eval body.
  Catches `eval("fetch('/api/x')")`.
- **`Function.prototype.toString` anti-detection**: returns
  `"function () { [native code] }"` for all our patched functions so
  sites' native-code checks (`fn.toString().includes('native code')`)
  pass. Uses a `WeakSet` of patched functions to identify them.
- **`Object.getOwnPropertyNames` / `getOwnPropertyDescriptors`** overrides:
  hide our `__proxy-*` sidecar attributes from code that enumerates
  element properties. Otherwise libraries that diff DOM state (React
  fiber, Vue reactivity) would see them and may break.
- **`HTMLAnchorElement.prototype.protocol/host/hostname/port/pathname/
  search/hash` descriptor overrides**: these have their own descriptors
  that returned the proxy host. Now they return the target host
  (parsed from the sidecar href or unwrapped from the actual href).
  Sites that do `if (a.hostname === "lichess.org")` now succeed.
- **`Worklet.prototype.addModule` override**: rewrites the script URL
  for AudioWorklets / PaintWorklets / AnimationWorklets.
- **`URL.createObjectURL` / `revokeObjectURL`**: documented as no-op
  (blob URLs don't need rewriting themselves; the `Worker` constructor
  patch handles blob workers).
- **Server `__porigin` query param stripping** for ALL HTTP requests
  (was only WS upgrades): strict targets that validate query params
  were rejecting `?__porigin=<encoded>`.
- **Server `Set-Cookie Path=` stripping**: now strips the original
  `Path=/dashboard` before adding our `Path=/p/<encoded>/`. Prevents
  duplicate Path attributes.

### v9
- Server strips `integrity` and `nonce` from `<script>`/`<link>` tags.
- Server strips original `Path=` from Set-Cookie.
- Server strips `__porigin` from ALL HTTP requests.
- Server rewrites `<iframe srcdoc="...">` inline HTML.
- Server rewrites CSS `@import` rules.
- `Element.prototype.setAttribute` "delete route" for integrity/nonce/CSP.
- `Element.prototype.setAttributeNS` (SVG `xlink:href`).
- `Element.prototype.insertAdjacentHTML` (jQuery, Svelte, etc.).
- `Element.prototype.cloneNode` (re-stash sidecars on deep clones).
- `Element.prototype.getAttribute` handles ALL `__proxy-*` sidecars (case-insensitive).
- `window.URL` constructor + `URL.canParse` overrides.
- `Response.url` / `Request.url` / `XHR.responseURL` getter overrides.
- `navigator.sendBeacon` override.
- `Audio` constructor override.
- `CSSStyleSheet.insertRule` / `replaceSync` overrides.
- `document.referrer` override.
- `$proxySet$` compound assignment on `location` fixed.
- `$proxyCall$m` no longer swallows errors.
- `window.postMessage` uses proxy origin.
- MutationObserver watches `attributes` + walks Shadow DOM.
- `ORIG` reference object avoids recursion.

### v8
- HTML element descriptor overrides for ALL URL-bearing properties.
- `Element.prototype.setAttribute` for ALL URL attribute names.
- `Element.prototype.innerHTML` / `outerHTML`.
- `Document.prototype.write` / `writeln`.
- `window.postMessage` (rewrites targetOrigin).
- `MessageEvent.prototype.origin`.
- `document.domain`.
- `CSSStyleDeclaration.setProperty` + descriptors.
- `Worker` / `SharedWorker` constructors.
- `navigator.serviceWorker.register`.
- `localStorage` / `sessionStorage` per-origin namespacing.

### v7
- New `rewriteJsonBody` for JSON content.
- `type="application/json"` inline scripts (e.g. `__NEXT_DATA__`).
- `crossorigin="use-credentials"` stripped from manifest/icon links.

### v6
- JS AST rewriter (`lib/jsRewrite.js`).
- Location emulation in `public/proxy-client.js`.
- `history.pushState`/`replaceState` call `updateLocationEmulation`.
- `document.URL`/`documentURI`/`baseURI`/`window.origin` overrides.
- Anchor click handler removed (was desyncing React 18).
- Inline `<script>` blocks get the JS AST rewriter applied.
- Absolute `https?://` URLs in inline scripts NOT rewritten.

### v5
- Double-prefix bug on cross-origin absolute URLs (Replit killer).
- `<meta http-equiv="Content-Security-Policy">` stripped (Lichess killer).
- CSS `url('/foo')` rewriter.
- Cross-apex origins proxied (lichess1.org, cdn.replit.com, identitytoolkit).
- srcset/imagesrcset descriptor-aware splitter.
- SVG `<use>`/`<image>`/`xlink:href`, meta refresh, data-bg/data-original.

### v4
- Streaming responses no longer buffered.
- Broton decompression fixed.
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
