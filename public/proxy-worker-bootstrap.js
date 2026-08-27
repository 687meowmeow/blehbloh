// proxy-worker-bootstrap.js
//
// Injected at the top of every worker script (via importScripts) by the
// server-side JS rewriter when it detects a worker request (Sec-Fetch-Dest:
// worker / shared-worker / service-worker / audio-worklet).
//
// This is the worker-context equivalent of proxy-client.js. It patches:
//   - self.fetch / XMLHttpRequest (rewrite URL + add X-Proxy-Origin header)
//   - self.importScripts (rewrite script URLs)
//   - self.WebSocket / EventSource (rewrite URL + add __porigin query)
//   - self.location (WorkerLocation emulation — return target's URL parts)
//   - self.postMessage (worker → main thread: rewrite targetOrigin)
//
// What it does NOT patch (workers can't access these):
//   - document / window / Element / DOM APIs
//   - history
//   - localStorage / sessionStorage (some browsers do expose these in workers
//     but we'll skip for now)

(function () {
  // Worker global is `self`. Use it instead of `window`.
  if (typeof self === 'undefined') return;

  // Read the bootstrap config from `self.__proxyWorkerConfig` (set by the
  // server-side bootstrap wrapper). It contains:
  //   - targetOrigin: e.g. "https://replit.com"
  //   - encoded: base64url of targetOrigin
  //   - prefix: "/p/<encoded>"
  //   - proxyHost: location.host
  const config = self.__proxyWorkerConfig;
  if (!config) return;
  const TARGET_ORIGIN = config.targetOrigin;
  const ENCODED = config.encoded;
  const PREFIX = config.prefix;
  const PROXY_HOST = config.proxyHost || self.location.host;

  function encodeOrigin(origin) {
    try { return btoa(origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    catch { return ''; }
  }
  function decodeOrigin(enc) {
    try {
      const b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      return atob(padded);
    } catch { return ''; }
  }

  // Unwrap a proxied URL → target URL.
  function unwrapUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      const u = new URL(url, self.location.href);
      const m = u.pathname.match(/^\/p\/([^/]+)(.*)$/);
      if (!m) return null;
      const origin = decodeOrigin(m[1]);
      if (!origin) return null;
      return origin + m[2] + (u.search || '') + (u.hash || '');
    } catch { return null; }
  }

  // Rewrite a URL to its proxied form. Same logic as proxy-client.js.
  function rewriteUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith(PREFIX)) return url;
    if (url.startsWith('/p/')) return url;
    if (/^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url, TARGET_ORIGIN);
        return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      } catch { return url; }
    }
    if (url.startsWith('//')) {
      try {
        const u = new URL('https:' + url);
        return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      } catch { return url; }
    }
    if (/^wss?:\/\//i.test(url)) {
      try {
        const proto = url.startsWith('wss') ? 'wss' : 'ws';
        const httpProto = proto === 'wss' ? 'https' : 'http';
        const u = new URL(url.replace(/^wss?:\/\//i, httpProto + '://'));
        const enc = encodeOrigin(proto === 'wss' ? 'https://' + u.host : 'http://' + u.host);
        return `${proto}://${PROXY_HOST}/p/${enc}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      } catch { return url; }
    }
    if (url.startsWith('/') && !url.startsWith('//')) return PREFIX + url;
    return url;
  }

  // --- Save original APIs before patching --------------------------------
  const ORIG = {
    fetch: self.fetch ? self.fetch.bind(self) : null,
    xhrOpen: (self.XMLHttpRequest && XMLHttpRequest.prototype.open) || null,
    xhrSend: (self.XMLHttpRequest && XMLHttpRequest.prototype.send) || null,
    importScripts: self.importScripts ? self.importScripts.bind(self) : null,
    WebSocket: self.WebSocket || null,
    EventSource: self.EventSource || null,
    postMessage: self.postMessage ? self.postMessage.bind(self) : null,
  };

  // --- self.fetch -----------------------------------------------------
  if (ORIG.fetch) {
    self.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = rewriteUrl(input);
        else if (input && input.url) input = new Request(rewriteUrl(input.url), input);
        init = init || {};
        let headers = init.headers || (input instanceof Request ? input.headers : undefined);
        if (!headers) { headers = {}; init.headers = headers; }
        if (headers instanceof Headers) {
          if (!headers.has('X-Proxy-Origin')) headers.set('X-Proxy-Origin', TARGET_ORIGIN);
          init.headers = headers;
        } else if (Array.isArray(headers)) {
          if (!headers.some(([k]) => k.toLowerCase() === 'x-proxy-origin')) {
            headers.push(['X-Proxy-Origin', TARGET_ORIGIN]);
          }
          init.headers = headers;
        } else {
          headers['X-Proxy-Origin'] = TARGET_ORIGIN;
          init.headers = headers;
        }
      } catch (e) { /* fall through */ }
      return ORIG.fetch(input, init);
    };
  }

  // --- XMLHttpRequest.open + send -------------------------------------
  if (ORIG.xhrOpen && ORIG.xhrSend) {
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { url = rewriteUrl(String(url)); } catch (e) { /* keep */ }
      this.__proxyOrigin = TARGET_ORIGIN;
      return ORIG.xhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this.__proxyOrigin) {
          this.setRequestHeader('X-Proxy-Origin', this.__proxyOrigin);
        }
      } catch (e) { /* ignore */ }
      return ORIG.xhrSend.call(this, body);
    };
  }

  // --- importScripts --------------------------------------------------
  // Workers can synchronously importScripts('foo.js'). Rewrite each URL.
  if (ORIG.importScripts) {
    self.importScripts = function (...scripts) {
      const rewritten = scripts.map(s => {
        try { return rewriteUrl(String(s)); }
        catch (e) { return s; }
      });
      return ORIG.importScripts(...rewritten);
    };
  }

  // --- WebSocket constructor -----------------------------------------
  if (ORIG.WebSocket) {
    const OrigWebSocket = ORIG.WebSocket;
    function PatchedWebSocket(url, protocols) {
      try {
        if (typeof url === 'string') url = rewriteUrl(url);
        if (typeof url === 'string' && url.indexOf('__porigin=') < 0) {
          const sep = url.indexOf('?') >= 0 ? '&' : '?';
          url = url + sep + '__porigin=' + encodeOrigin(TARGET_ORIGIN);
        }
      } catch (e) { /* keep */ }
      if (Array.isArray(protocols)) return new OrigWebSocket(url, ...protocols);
      return new OrigWebSocket(url, protocols);
    }
    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    self.WebSocket = PatchedWebSocket;
  }

  // --- EventSource constructor ---------------------------------------
  if (ORIG.EventSource) {
    const OrigES = ORIG.EventSource;
    function PatchedES(url, config) {
      try {
        if (typeof url === 'string') {
          url = rewriteUrl(url);
          if (url.indexOf('__porigin=') < 0) {
            const sep = url.indexOf('?') >= 0 ? '&' : '?';
            url = url + sep + '__porigin=' + encodeOrigin(TARGET_ORIGIN);
          }
        }
      } catch (e) { /* keep */ }
      return new OrigES(url, config);
    }
    PatchedES.prototype = OrigES.prototype;
    PatchedES.CONNECTING = OrigES.CONNECTING;
    PatchedES.OPEN = OrigES.OPEN;
    PatchedES.CLOSED = OrigES.CLOSED;
    self.EventSource = PatchedES;
  }

  // --- self.postMessage (worker → main) ------------------------------
  // Workers use `postMessage(message, transfer)` (no targetOrigin arg).
  // The main thread's MessageEvent.origin will be our proxy origin. The
  // main thread's proxy-client.js patches MessageEvent.origin to return
  // the target origin, so receivers' origin checks pass.
  // We don't need to do anything here — the receiver handles it.

  // --- WorkerLocation emulation -------------------------------------
  // Workers have `self.location` (a WorkerLocation). It returns the
  // worker script's URL, which is `/p/<encoded>/<path>.js`. Sites that
  // read self.location.origin/pathname to compute relative URLs would
  // get proxy paths. Override the getters to return target's URL parts.
  if (self.WorkerLocation) {
    try {
      // Parse the worker URL: /p/<encoded>/<path>
      const wUrl = new URL(self.location.href);
      const m = wUrl.pathname.match(/^\/p\/([^/]+)(.*)$/);
      if (m) {
        const origin = decodeOrigin(m[1]);
        const path = m[2] || '/';
        const targetHref = origin + path + (wUrl.search || '') + (wUrl.hash || '');
        const _url = new URL(targetHref);
        const keys = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];
        for (const key of keys) {
          try {
            Object.defineProperty(self.location, key, {
              get() { return _url[key]; },
              configurable: true,
            });
          } catch (e) { /* WorkerLocation props may not be redefinable */ }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Mark the bootstrap as installed so a second importScripts call is a no-op.
  self.__proxyBootstrapInstalled = true;
})();
