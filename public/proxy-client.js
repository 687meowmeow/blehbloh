// proxy-client.js
//
// Injected at the top of every proxied HTML document. Patches the browser
// APIs that pages use to navigate, fetch, or open new windows so that URLs
// pointing at the target origin (or its subdomains) are rewritten back
// through the /p/<encoded>/ proxy path.
//
// What this catches:
//   - history.pushState / replaceState
//   - fetch()
//   - XMLHttpRequest.open()
//   - window.open()
//   - location.assign / location.replace
//   - dynamically inserted <a>, <img>, <script>, <link>, <iframe>, <source>
//     via MutationObserver
//
// What this cannot catch:
//   - direct `location.href = "https://target/..."` assignments (the
//     location object is not patchable; we'd need a Service Worker to
//     intercept the resulting navigation).
//
// All patching is wrapped in try/catch so a failure in one hook doesn't
// break the page entirely.

(function () {
  const scriptTag = document.currentScript;
  if (!scriptTag) return; // shouldn't happen, we always inject with <script>
  const TARGET_ORIGIN = scriptTag.getAttribute('data-target-origin');
  const ENCODED = scriptTag.getAttribute('data-encoded');
  const PREFIX = scriptTag.getAttribute('data-prefix'); // "/p/<encoded>"

  if (!TARGET_ORIGIN || !ENCODED || !PREFIX) return;

  // Save references to the original (un-patched) browser APIs at the very
  // top of the IIFE, before any patches are applied. We use these inside
  // patches to avoid recursion.
  const ORIG = {
    setAttribute: Element.prototype.setAttribute,
    getAttribute: Element.prototype.getAttribute,
    setAttributeNS: Element.prototype.setAttributeNS,
    insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
    cloneNode: Node.prototype.cloneNode,
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    pushState: history.pushState.bind(history),
    replaceState: history.replaceState.bind(history),
    postMessage: window.postMessage.bind(window),
    workerCtor: window.Worker,
    sharedWorkerCtor: window.SharedWorker,
  };

  const targetUrl = (function () {
    try { return new URL(TARGET_ORIGIN); } catch { return null; }
  })();
  const TARGET_HOST = targetUrl ? targetUrl.hostname : null;
  // eTLD+1: drop the leftmost subdomain label. For "lichess.org" this stays
  // "lichess.org"; for "socket.lichess.org" it becomes "lichess.org".
  function apexOf(host) {
    if (!host) return null;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
  }
  const TARGET_APEX = apexOf(TARGET_HOST);

  function encodeOrigin(origin) {
    // Must match the server's base64url encoding.
    try { return btoa(origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
    catch { return ''; }
  }

  // Decode a base64url-encoded origin.
  function decodeOrigin(enc) {
    try {
      const b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      return atob(padded);
    } catch { return ''; }
  }

  // --- URL unwrap -----------------------------------------------------
  // Given a proxied URL (e.g. /p/<encoded>/<path>), return the original URL.
  // Returns null if `url` is not a proxied URL.
  function unwrapUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/^\/p\/([^/]+)(.*)$/);
      if (!m) return null;
      const origin = decodeOrigin(m[1]);
      if (!origin) return null;
      return origin + m[2] + (u.search || '') + (u.hash || '');
    } catch { return null; }
  }

  // --- Location emulation --------------------------------------------
  // `window.location` is [Unforgeable] — we can't redefine it. The JS AST
  // rewriter (on the server) rewrites reads of `location` to call
  // $proxyGet$(window, "location") which returns THIS emulation. The
  // emulation's getters return the TARGET's URL parts (parsed by unwrapping
  // the proxy prefix), and the setters do `window.location.href =
  // proxyPrefix(rewrittenUrl)` to navigate through the proxy.
  function createLocationEmulation() {
    // Parse the current proxy URL to get the target URL.
    const proxyUrl = new URL(location.href);
    const m = proxyUrl.pathname.match(/^\/p\/([^/]+)(.*)$/);
    if (!m) return null;
    const origin = decodeOrigin(m[1]);
    if (!origin) return null;
    const path = m[2] || '/';
    const targetHref = origin + path + (proxyUrl.search || '') + (proxyUrl.hash || '');
    let _url;
    try { _url = new URL(targetHref); }
    catch { return null; }

    const emu = {};
    emu._url = _url; // exposed so updateLocationEmulation can replace it
    const props = ['hash', 'host', 'hostname', 'href', 'pathname', 'port', 'protocol', 'search', 'origin'];
    for (const p of props) {
      Object.defineProperty(emu, p, {
        get() { return emu._url[p]; },
        set(val) {
          if (p === 'origin') return; // origin is read-only
          if (p === 'href') {
            // Navigate through the proxy.
            try {
              const newUrl = new URL(val, emu._url);
              window.location.href = rewriteUrl(newUrl.href);
            } catch (e) {}
            return;
          }
          try {
            emu._url[p] = val;
            // Navigate through the proxy with the modified URL.
            window.location.href = rewriteUrl(emu._url.href);
          } catch (e) {}
        },
        enumerable: true,
        configurable: true,
      });
    }
    emu.assign = function (url) {
      try { window.location.assign(rewriteUrl(String(url))); } catch (e) {}
    };
    emu.replace = function (url) {
      try { window.location.replace(rewriteUrl(String(url))); } catch (e) {}
    };
    emu.reload = function () { window.location.reload(); };
    emu.toString = function () { return emu._url.href; };
    return emu;
  }

  const LOCATION_EMU = createLocationEmulation();
  const PARENT_EMU = LOCATION_EMU ? { location: LOCATION_EMU, postMessage: window.parent.postMessage.bind(window.parent) } : null;
  const TOP_EMU = LOCATION_EMU ? { location: LOCATION_EMU, postMessage: window.top.postMessage.bind(window.top) } : null;

  // Re-parse the proxy URL and update the location emulation's internal
  // URL. Called after history.pushState/replaceState/popstate so that
  // subsequent reads of `location.pathname` etc. reflect the new path.
  function updateLocationEmulation() {
    if (!LOCATION_EMU) return;
    try {
      const proxyUrl = new URL(location.href);
      const m = proxyUrl.pathname.match(/^\/p\/([^/]+)(.*)$/);
      if (!m) return;
      const origin = decodeOrigin(m[1]);
      if (!origin) return;
      const path = m[2] || '/';
      const targetHref = origin + path + (proxyUrl.search || '') + (proxyUrl.hash || '');
      LOCATION_EMU._url = new URL(targetHref);
    } catch (e) {}
  }

  // --- $proxyGet$ / $proxySet$ globals ---------------------------------
  // The JS AST rewriter (server-side) rewrites `location` reads to call
  // these. They return our emulation instead of the real `window.location`.
  window.$proxyGet$ = function (obj, key) {
    try {
      if ((obj === window || obj === document) && key === 'location' && LOCATION_EMU) {
        return LOCATION_EMU;
      }
      if (obj === window && key === 'parent' && PARENT_EMU) {
        return PARENT_EMU;
      }
      if (obj === window && key === 'top' && TOP_EMU) {
        return TOP_EMU;
      }
    } catch (e) {}
    return obj[key];
  };
  window.$proxySet$ = function (obj, key, val, operator) {
    try {
      if ((obj === window || obj === document) && key === 'location' && LOCATION_EMU) {
        // location = "..." → navigate via proxy.
        if (val == null) {
          // Update expression (location++ etc.) — nonsensical, ignore.
          return;
        }
        if (operator && operator !== '=') {
          // Compound assignment (+=, -=, etc.) — read current value from
          // the emulation, compute the new value, navigate.
          const cur = LOCATION_EMU.href;
          let newHref;
          switch (operator) {
            case '+=': newHref = cur + val; break;
            default: newHref = String(val);
          }
          LOCATION_EMU.href = String(newHref);
          return;
        }
        LOCATION_EMU.href = String(val);
        return;
      }
      if (obj === window && key === 'parent' && PARENT_EMU) {
        // window.parent = ... — nonsensical, ignore.
        return;
      }
      if (obj === window && key === 'top' && TOP_EMU) {
        // window.top = ... — nonsensical, ignore.
        return;
      }
    } catch (e) {}
    // Default: fall back to the actual property assignment.
    if (operator && operator !== '=') {
      // Compound assignment (+=, etc.). Apply via the real obj.
      try {
        const cur = obj[key];
        switch (operator) {
          case '+=': obj[key] = cur + val; break;
          case '-=': obj[key] = cur - val; break;
          case '*=': obj[key] = cur * val; break;
          case '/=': obj[key] = cur / val; break;
          case '%=': obj[key] = cur % val; break;
          case '**=': obj[key] = cur ** val; break;
          case '<<=': obj[key] = cur << val; break;
          case '>>=': obj[key] = cur >> val; break;
          case '>>>=': obj[key] = cur >>> val; break;
          case '&=': obj[key] = cur & val; break;
          case '^=': obj[key] = cur ^ val; break;
          case '|=': obj[key] = cur | val; break;
          case '&&=': obj[key] = cur && val; break;
          case '||=': obj[key] = cur || val; break;
          case '??=': obj[key] = cur ?? val; break;
          case '++': obj[key] = cur + 1; break;
          case '--': obj[key] = cur - 1; break;
          default: obj[key] = val;
        }
      } catch (e) {}
      return;
    }
    try { obj[key] = val; } catch (e) {}
  };
  window.$proxyCall$m = function (obj, key, args) {
    // Don't swallow genuine errors — if obj[key] throws, propagate.
    // (Otherwise `try { location.assign(x) } catch(e){...}` never fires.)
    return obj[key](...args);
  };

  // --- Document URL / baseURI / referrer overrides --------------------
  // Sites use document.URL, document.baseURI, document.referrer to know
  // their own URL. Override the getters to return the TARGET's URL instead
  // of the proxy's.
  try {
    Object.defineProperty(document, 'URL', {
      get() { return LOCATION_EMU ? LOCATION_EMU.href : location.href; },
      configurable: true,
    });
  } catch (e) {}
  try {
    Object.defineProperty(document, 'documentURI', {
      get() { return LOCATION_EMU ? LOCATION_EMU.href : location.href; },
      configurable: true,
    });
  } catch (e) {}
  try {
    Object.defineProperty(Node.prototype, 'baseURI', {
      get() { return TARGET_ORIGIN + '/'; },
      configurable: true,
    });
  } catch (e) {}
  // window.origin override (window.origin IS configurable, unlike
  // window.location).
  try {
    Object.defineProperty(window, 'origin', {
      get() { return TARGET_ORIGIN; },
      configurable: true,
    });
  } catch (e) {}

  // document.referrer override. The browser sets this from the Referer
  // header, which on a proxied request is the proxy URL of the previous
  // page. Sites compare to location.origin for CSRF checks — unwrap so
  // the comparison succeeds.
  try {
    const referrerDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer');
    if (referrerDesc && referrerDesc.get) {
      Object.defineProperty(document, 'referrer', {
        get() {
          const real = referrerDesc.get.call(document);
          if (!real) return real;
          const unwrapped = unwrapUrl(real);
          return unwrapped || real;
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // --- URL constructor override ------------------------------------
  // Sites do `new URL("/foo", location.origin)` and expect the result to
  // be a URL on the target origin. With our AST rewriter, `location.origin`
  // becomes `$proxyGet$(window, "location").origin` which returns the
  // target origin — so the URL constructor gets the right base. But other
  // paths bypass the AST rewriter (eval, new Function, code that failed
  // to parse). Wrap the URL constructor to unwrap the base if it's a
  // proxy URL.
  try {
    const OrigURL = window.URL;
    function PatchedURL(url, base) {
      if (typeof base === 'string') {
        const unwrapped = unwrapUrl(base);
        if (unwrapped) base = unwrapped;
      }
      if (typeof url === 'string') {
        const unwrapped = unwrapUrl(url);
        if (unwrapped) url = unwrapped;
      }
      return new OrigURL(url, base);
    }
    // Copy static methods.
    PatchedURL.createObjectURL = OrigURL.createObjectURL;
    PatchedURL.revokeObjectURL = OrigURL.revokeObjectURL;
    PatchedURL.prototype = OrigURL.prototype;
    if (OrigURL.canParse) {
      PatchedURL.canParse = function (url, base) {
        try {
          if (typeof base === 'string') {
            const unwrapped = unwrapUrl(base);
            if (unwrapped) base = unwrapped;
          }
          if (typeof url === 'string') {
            const unwrapped = unwrapUrl(url);
            if (unwrapped) url = unwrapped;
          }
          return OrigURL.canParse(url, base);
        } catch (e) { return false; }
      };
    }
    window.URL = PatchedURL;
  } catch (e) { /* ignore */ }

  // --- Response.prototype.url + Request.prototype.url + XHR.responseURL ---
  // These getters return the proxied URL — sites compare them to target
  // URLs for caching keys, OAuth redirect detection, etc. Unwrap to the
  // target URL.
  try {
    const responseUrlDesc = Object.getOwnPropertyDescriptor(Response.prototype, 'url');
    if (responseUrlDesc && responseUrlDesc.get) {
      Object.defineProperty(Response.prototype, 'url', {
        get() {
          const real = responseUrlDesc.get.call(this);
          if (!real) return real;
          const unwrapped = unwrapUrl(real);
          return unwrapped || real;
        },
        configurable: true,
      });
    }
  } catch (e) {}
  try {
    const requestUrlDesc = Object.getOwnPropertyDescriptor(Request.prototype, 'url');
    if (requestUrlDesc && requestUrlDesc.get) {
      Object.defineProperty(Request.prototype, 'url', {
        get() {
          const real = requestUrlDesc.get.call(this);
          if (!real) return real;
          const unwrapped = unwrapUrl(real);
          return unwrapped || real;
        },
        configurable: true,
      });
    }
  } catch (e) {}
  try {
    const xhrUrlDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL');
    if (xhrUrlDesc && xhrUrlDesc.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'responseURL', {
        get() {
          const real = xhrUrlDesc.get.call(this);
          if (!real) return real;
          const unwrapped = unwrapUrl(real);
          return unwrapped || real;
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // --- navigator.sendBeacon ----------------------------------------
  // Analytics endpoints (GA collect, /beacon, /track) go directly to the
  // target — leaks IP and 404s. Rewrite the URL.
  try {
    const origSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        if (typeof url === 'string') url = rewriteUrl(url);
      } catch (e) { /* keep */ }
      return origSendBeacon(url, data);
    };
  } catch (e) { /* ignore */ }

  // --- Audio constructor --------------------------------------------
  // new Audio("/foo.mp3") — the constructor arg goes directly to fetch.
  // HTMLMediaElement.src setter only fires on `el.src = ...`.
  try {
    const OrigAudio = window.Audio;
    if (OrigAudio) {
      function PatchedAudio(src) {
        try {
          if (typeof src === 'string') src = rewriteUrl(src);
        } catch (e) { /* keep */ }
        return new OrigAudio(src);
      }
      PatchedAudio.prototype = OrigAudio.prototype;
      window.Audio = PatchedAudio;
    }
  } catch (e) { /* ignore */ }

  // --- Image constructor -------------------------------------------
  // new Image() doesn't take src, but `new Image(width, height)` is fine.
  // The descriptor setter for HTMLImageElement.src catches assignments
  // after construction. No override needed.

  // --- CSSStyleSheet.insertRule + replaceSync ----------------------
  // Lit-element / Constructable Stylesheets use these. Inserted rules
  // with url('/foo') bypass our CSS patches.
  try {
    const origInsertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      try {
        if (typeof rule === 'string' && /url\(/i.test(rule)) {
          rule = rule.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, q, u) => {
            if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return full;
            try { return `url(${q}${rewriteUrl(u)}${q})`; }
            catch (e) { return full; }
          });
        }
      } catch (e) { /* keep */ }
      return origInsertRule.call(this, rule, index);
    };
  } catch (e) { /* ignore */ }
  try {
    const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
    if (origReplaceSync) {
      CSSStyleSheet.prototype.replaceSync = function (text) {
        try {
          if (typeof text === 'string' && /url\(/i.test(text)) {
            text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, q, u) => {
              if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return full;
              try { return `url(${q}${rewriteUrl(u)}${q})`; }
              catch (e) { return full; }
            });
          }
        } catch (e) { /* keep */ }
        return origReplaceSync.call(this, text);
      };
    }
  } catch (e) { /* ignore */ }

  // Rewrite a single URL string to its proxied form. We rewrite ALL absolute
  // URLs (any origin) through /p/<encoded-of-that-origin>/... — not just
  // target-subdomain URLs. This is critical for sites like Replit that fan
  // out to sibling origins (reachability.replit.app, *.replit.dev, etc.)
  // and Firebase (identitytoolkit.googleapis.com). Without rewriting ALL
  // absolute URLs, those cross-origin requests go directly from the
  // browser to the upstream, leaking the user's real IP and failing CORS.
  function rewriteUrl(url) {
    if (!url || typeof url !== 'string') return url;

    // Already proxied.
    if (url.startsWith(PREFIX)) return url;
    // Don't double-proxy a URL that's already /p/<encoded>/...
    if (url.startsWith('/p/') && url.length > 3 && /[a-zA-Z0-9_-]+/.test(url.slice(3))) return url;

    // Absolute https?:// URL — proxy it.
    if (/^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url, TARGET_ORIGIN);
        const out = `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
        return out;
      } catch { return url; }
    }

    // Protocol-relative //host
    if (url.startsWith('//')) {
      try {
        const u = new URL('https:' + url);
        return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      } catch { return url; }
    }

    // ws(s):// — proxy via ws(s)://our-host/p/<encoded>/
    if (/^wss?:\/\//i.test(url)) {
      try {
        const proto = url.startsWith('wss') ? 'wss' : 'ws';
        const httpProto = proto === 'wss' ? 'https' : 'http';
        const u = new URL(url.replace(/^wss?:\/\//i, httpProto + '://'));
        const enc = encodeOrigin(proto === 'wss' ? 'https://' + u.host : 'http://' + u.host);
        return `${proto}://${location.host}/p/${enc}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      } catch { return url; }
    }

    // Absolute path: prepend the target's proxy prefix so the browser
    // navigates inside the proxy instead of treating it as a path on our
    // domain. (The <base> tag does NOT affect absolute paths.)
    if (url.startsWith('/') && !url.startsWith('//')) {
      return PREFIX + url;
    }

    // Relative URL: leave it. The injected <base href="/p/<encoded>/"> tag
    // makes it resolve correctly inside the proxy.
    return url;
  }

  // --- history.pushState / replaceState -------------------------------
  // Rewrite the URL and update our location emulation afterwards so that
  // subsequent reads of `location.pathname` (e.g. by the SPA router) return
  // the new path under the TARGET origin (not the proxy prefix).
  try {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function (state, title, url) {
      let r;
      if (url) {
        r = rewriteUrl(String(url));
        const result = origPush(state, title, r);
        updateLocationEmulation();
        return result;
      }
      return origPush(state, title);
    };
    history.replaceState = function (state, title, url) {
      let r;
      if (url) {
        r = rewriteUrl(String(url));
        const result = origReplace(state, title, r);
        updateLocationEmulation();
        return result;
      }
      return origReplace(state, title);
    };
    // Also update on popstate (back/forward navigation).
    window.addEventListener('popstate', () => updateLocationEmulation());
  } catch (e) { /* ignore */ }

  // --- fetch() --------------------------------------------------------
  // Patch fetch to rewrite the URL AND attach X-Proxy-Origin so the server
  // knows what the "real" page origin is. Without this, the server can't
  // tell a cross-origin request (e.g. Replit -> identitytoolkit.googleapis.com)
  // from a same-origin one, and ends up sending the wrong Origin header to
  // the target (which breaks Firebase CORS preflights, among others).
  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === 'string') {
            input = rewriteUrl(input);
          } else if (input && input.url) {
            input = new Request(rewriteUrl(input.url), input);
          }
          // Attach the page origin so the server can set the correct
          // Origin header on the upstream request. If init already has
          // headers, merge without clobbering.
          init = init || {};
          if (input instanceof Request && !init.headers) {
            // pass through; we'll add the header below
          }
          let headers = init.headers || (input instanceof Request ? input.headers : undefined);
          if (!headers) { headers = {}; init.headers = headers; }
          // Headers can be a Headers object, a plain object, or an array.
          // Convert to a plain object we can safely add to.
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
        } catch (e) { /* fall through with original input */ }
        return origFetch.call(this, input, init);
      };
    }
  } catch (e) { /* ignore */ }

  // --- XMLHttpRequest.open() + send() ---------------------------------
  // XHR doesn't have a per-call init object, so we stash the URL rewrite at
  // open() time and add X-Proxy-Origin at send() time via setRequestHeader.
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { url = rewriteUrl(String(url)); } catch (e) { /* keep */ }
      this.__proxyOrigin = TARGET_ORIGIN;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this.__proxyOrigin) {
          this.setRequestHeader('X-Proxy-Origin', this.__proxyOrigin);
        }
      } catch (e) { /* ignore */ }
      return origSend.call(this, body);
    };
  } catch (e) { /* ignore */ }

  // --- window.open() --------------------------------------------------
  try {
    const origOpen = window.open;
    window.open = function (url, ...rest) {
      try { if (url) url = rewriteUrl(String(url)); } catch (e) { /* keep */ }
      return origOpen.call(this, url, ...rest);
    };
  } catch (e) { /* ignore */ }

  // --- location.assign / location.replace -----------------------------
  try {
    const origAssign = location.assign.bind(location);
    const origReplace = location.replace.bind(location);
    location.assign = function (url) {
      try { url = rewriteUrl(String(url)); } catch (e) { /* keep */ }
      return origAssign(url);
    };
    location.replace = function (url) {
      try { url = rewriteUrl(String(url)); } catch (e) { /* keep */ }
      return origReplace(url);
    };
  } catch (e) { /* ignore */ }

  // --- WebSocket constructor -------------------------------------------
  // Many sites (e.g. lichess) build the ws:// URL dynamically in JS, so the
  // server-side HTML rewriter can't catch it. Patch the constructor to
  // rewrite the URL AND append the page origin as a query param so the
  // server can set the correct Origin header on the upstream handshake.
  // (Browsers don't allow setting custom headers on WebSocket, so we have
  // to smuggle the page origin via the URL.)
  try {
    const OrigWebSocket = window.WebSocket;
    function PatchedWebSocket(url, protocols) {
      try {
        if (typeof url === 'string') url = rewriteUrl(url);
        else if (url && url.url) url = rewriteUrl(url.url);
        // Append the page origin so the server's upgrade handler can
        // use it for the Origin header on the upstream request.
        if (typeof url === 'string' && url.indexOf('__porigin=') < 0) {
          const sep = url.indexOf('?') >= 0 ? '&' : '?';
          url = url + sep + '__porigin=' + encodeOrigin(TARGET_ORIGIN);
        }
      } catch (e) { /* keep */ }
      if (Array.isArray(protocols)) return new OrigWebSocket(url, ...protocols);
      return new OrigWebSocket(url, protocols);
    }
    // Mirror static props + constants.
    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    window.WebSocket = PatchedWebSocket;
  } catch (e) { /* ignore */ }

  // --- EventSource (SSE) constructor ----------------------------------
  // Same pattern as WebSocket: rewrite the URL + attach page origin.
  try {
    const OrigES = window.EventSource;
    if (OrigES) {
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
      window.EventSource = PatchedES;
    }
  } catch (e) { /* ignore */ }

  // --- Anchor interception --------------------------------------------
  // We DON'T use a capture-phase click listener — that would desync
  // React 18's synthetic event system (it walks the DOM during the
  // click handler and gets confused if attributes change mid-event).
  // Instead, we override HTMLAnchorElement.prototype.href's descriptor so
  // the browser navigates the proxied URL while getAttribute returns the
  // user's intended (un-proxied) URL via a sidecar attribute. This is the
  // pattern Corrosion uses.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
    if (descriptor && descriptor.get && descriptor.set) {
      Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
        get() {
          // If we stashed the original, return it.
          const orig = this.getAttribute('__proxy-href');
          if (orig != null) return orig;
          return descriptor.get.call(this);
        },
        set(val) {
          // Stash the original under a sidecar attribute, then set the
          // actual href to the proxied URL.
          try {
            this.setAttribute('__proxy-href', String(val));
            const rewritten = rewriteUrl(String(val));
            return descriptor.set.call(this, rewritten);
          } catch (e) {
            return descriptor.set.call(this, val);
          }
        },
        enumerable: true,
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }
  // Override getAttribute so it returns the sidecar value when present.
  // Sidecar names are `__proxy-<name>` (always lowercase) — set in our
  // patched setAttribute. We check for the lowercase sidecar regardless
  // of the case the caller used.
  try {
    Element.prototype.getAttribute = function (name) {
      if (typeof name === 'string' && this.hasAttribute) {
        const sidecar = '__proxy-' + name.toLowerCase();
        if (this.hasAttribute(sidecar)) {
          return ORIG.getAttribute.call(this, sidecar);
        }
      }
      return ORIG.getAttribute.call(this, name);
    };
  } catch (e) { /* ignore */ }

  // --- HTML element descriptor overrides -----------------------------
  // Override the getter/setter for HTMLAnchorElement.href, HTMLImageElement.src,
  // HTMLScriptElement.src, HTMLLinkElement.href, HTMLIFrameElement.src, etc.
  // so that when JS does `el.src = "/foo"`, the actual DOM attribute gets the
  // proxied URL while getAttribute returns the original (via the sidecar).
  // This handles dynamic property assignments (not just setAttribute calls).
  try {
    const DESCRIPTOR_OVERRIDES = [
      [HTMLAnchorElement.prototype, 'href'],
      [HTMLAreaElement.prototype, 'href'],
      [HTMLLinkElement.prototype, 'href'],
      [HTMLBaseElement.prototype, 'href'],
      [HTMLImageElement.prototype, 'src'],
      [HTMLImageElement.prototype, 'currentSrc'],  // read-only but we can spoof
      [HTMLScriptElement.prototype, 'src'],
      [HTMLIFrameElement.prototype, 'src'],
      [HTMLMediaElement.prototype, 'src'],
      [HTMLSourceElement.prototype, 'src'],
      [HTMLSourceElement.prototype, 'srcset'],
      [HTMLImageElement.prototype, 'srcset'],
      [HTMLInputElement.prototype, 'src'],
      [HTMLInputElement.prototype, 'formAction'],
      [HTMLButtonElement.prototype, 'formAction'],
      [HTMLFormElement.prototype, 'action'],
      [HTMLEmbedElement.prototype, 'src'],
      [HTMLObjectElement.prototype, 'data'],
      [HTMLTrackElement.prototype, 'src'],
      [HTMLVideoElement.prototype, 'poster'],
    ];
    for (const [proto, prop] of DESCRIPTOR_OVERRIDES) {
      if (!proto) continue;
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) continue;  // skip read-only props
      Object.defineProperty(proto, prop, {
        get: d.get ? function () {
          // If we stashed the original, return it.
          const orig = this.getAttribute && this.getAttribute('__proxy-' + prop);
          if (orig != null) return orig;
          return d.get.call(this);
        } : undefined,
        set: function (val) {
          try {
            if (this.setAttribute) this.setAttribute('__proxy-' + prop, String(val));
            const rewritten = rewriteUrl(String(val));
            return d.set.call(this, rewritten);
          } catch (e) {
            return d.set.call(this, val);
          }
        },
        enumerable: true,
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }

  // --- Element.prototype.setAttribute --------------------------------
  // Catch ALL setAttribute calls so dynamically inserted elements (not just
  // the MutationObserver) get URL attributes rewritten. Uses the sidecar
  // pattern: stash the original under __proxy-<attr> (lowercase), set the
  // actual attr to the proxied URL. getAttribute returns the sidecar.
  //
  // Also intercepts "delete route" attributes — `integrity` (SRI),
  // `http-equiv=Content-Security-Policy`, and `nonce` — which would block
  // our rewritten scripts if set dynamically. The patched setAttribute
  // removes the attribute entirely for these names.
  try {
    const URL_ATTR_NAMES = new Set([
      'href', 'src', 'action', 'poster', 'formaction', 'data', 'srcset',
      'imagesrcset', 'manifest', 'cite', 'longdesc', 'usemap', 'profile',
      'background', 'archive', 'codebase', 'classid', 'icon', 'ping',
      'data-src', 'data-href', 'data-url', 'data-bg', 'data-original',
      'data-lazy', 'data-lazy-src', 'data-srcset', 'data-poster',
      'data-share-url', 'data-download-url', 'use', 'xlink:href',
    ]);
    const DELETE_ATTR_NAMES = new Set([
      'integrity',  // SRI hashes — would block AST-rewritten scripts.
      'nonce',      // CSP nonces — would block our injected scripts.
    ]);
    Element.prototype.setAttribute = function (name, value) {
      if (typeof name === 'string') {
        const lower = name.toLowerCase();
        // "Delete route": strip integrity/nonce entirely.
        if (DELETE_ATTR_NAMES.has(lower)) {
          return ORIG.setAttribute.call(this, name, '');
        }
        // Special case: <meta http-equiv="Content-Security-Policy"> would
        // block our proxied scripts. Strip the content attribute when
        // http-equiv is set to CSP.
        if (lower === 'http-equiv' && typeof value === 'string' &&
            /Content-Security-Policy/i.test(value)) {
          try { ORIG.setAttribute.call(this, 'content', ''); } catch (e) {}
        }
        // URL attribute names: rewrite and stash sidecar.
        if (URL_ATTR_NAMES.has(lower)) {
          try {
            const rewritten = rewriteUrl(String(value));
            // Stash the original under the lowercase sidecar name.
            ORIG.setAttribute.call(this, '__proxy-' + lower, String(value));
            return ORIG.setAttribute.call(this, name, rewritten);
          } catch (e) { /* fall through */ }
        }
      }
      return ORIG.setAttribute.call(this, name, value);
    };
  } catch (e) { /* ignore */ }

  // --- Element.prototype.setAttributeNS -------------------------------
  // SVG uses setAttributeNS for namespaced attributes like xlink:href.
  try {
    Element.prototype.setAttributeNS = function (ns, name, value) {
      if (typeof name === 'string' && /xlink:href|href/i.test(name) && value) {
        try {
          const rewritten = rewriteUrl(String(value));
          return ORIG.setAttributeNS.call(this, ns, name, rewritten);
        } catch (e) { /* fall through */ }
      }
      return ORIG.setAttributeNS.call(this, ns, name, value);
    };
  } catch (e) { /* ignore */ }

  // --- Element.prototype.insertAdjacentHTML ---------------------------
  // jQuery .after()/.before()/.append() (older), Svelte {@html}, and many
  // template engines use this. The MutationObserver catches the inserted
  // nodes AFTER they're parsed, but the browser starts fetching <img src>
  // immediately on parse. Rewrite the HTML string first to prevent leaks.
  try {
    Element.prototype.insertAdjacentHTML = function (pos, html) {
      try { html = rewriteHtmlString(String(html)); } catch (e) { /* keep */ }
      return ORIG.insertAdjacentHTML.call(this, pos, html);
    };
  } catch (e) { /* ignore */ }

  // --- Element.prototype.cloneNode -----------------------------------
  // Deep clones copy our __proxy-* sidecars (good), but clones of
  // server-parsed elements with NO sidecar only have the rewritten attr.
  // Re-stash the sidecar so getAttribute continues to return the original.
  try {
    Node.prototype.cloneNode = function (deep) {
      const clone = ORIG.cloneNode.call(this, deep);
      if (clone && clone.nodeType === 1) {
        try {
          for (const attr of (clone.attributes || [])) {
            const name = attr.name;
            const value = attr.value;
            if (/^(href|src|action|formaction|data|poster|cite|background)$/i.test(name) && typeof value === 'string' && value.startsWith('/p/')) {
              const unwrapped = unwrapUrl(value);
              if (unwrapped) {
                try { ORIG.setAttribute.call(clone, '__proxy-' + name.toLowerCase(), unwrapped); } catch (e) {}
              }
            }
          }
        } catch (e) {}
      }
      return clone;
    };
  } catch (e) { /* ignore */ }

  // --- Element.prototype.innerHTML / outerHTML -------------------------
  // When JS sets el.innerHTML = '<a href="/foo">...', the embedded URLs
  // need rewriting before the browser parses them.
  try {
    function rewriteHtmlString(html) {
      if (!html || typeof html !== 'string') return html;
      // Reuse the same regex strategy as the server-side rewriter, but
      // client-side. Apply to absolute URLs, absolute paths, srcset, etc.
      // Absolute URLs (https?://host).
      html = html.replace(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(?::\d+)?(?:\/[^\s"'<>]*)?/g,
        (m) => { try { return rewriteUrl(m); } catch { return m; } });
      // Absolute paths in attributes: attr="/foo" → attr="/p/<encoded>/foo".
      html = html.replace(/(\b(?:href|src|action|poster|formaction|data|srcset|cite|use|image|background|longdesc|usemap|profile|archive|codebase|classid|icon|ping|data-src|data-href|data-url|data-bg|data-original|data-lazy-src|data-srcset|xlink:href)\s*=\s*["'])(\/[^"'\s>]+)/gi,
        (m, prefix, path) => {
          if (path.startsWith('//')) return m;
          if (path.startsWith('/p/')) return m;
          return prefix + PREFIX + path;
        });
      return html;
    }
    for (const prop of ['innerHTML', 'outerHTML']) {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(Element.prototype, prop, {
        get: d.get ? function () { return d.get.call(this); } : undefined,
        set: function (val) {
          try { val = rewriteHtmlString(String(val)); } catch (e) { /* keep */ }
          return d.set.call(this, val);
        },
        enumerable: true,
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }

  // --- Document.prototype.write / writeln -----------------------------
  // document.write() during page load injects HTML that needs rewriting.
  try {
    const origWrite = document.write.bind(document);
    const origWriteln = document.writeln.bind(document);
    function rewriteDocWrite(args) {
      if (args && args.length) {
        try {
          const joined = args.join('');
          // Reuse rewriteHtmlString — but it's defined inside the innerHTML
          // block above. Inline a simpler version here.
          let rewritten = joined;
          rewritten = rewritten.replace(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(?::\d+)?(?:\/[^\s"'<>]*)?/g,
            (m) => { try { return rewriteUrl(m); } catch { return m; } });
          rewritten = rewritten.replace(/(\b(?:href|src|action|poster|formaction|data|srcset|cite|use|image|background|longdesc|usemap|profile|archive|codebase|classid|icon|ping|data-src|data-href|data-url|data-bg|data-original|data-lazy-src|data-srcset|xlink:href)\s*=\s*["'])(\/[^"'\s>]+)/gi,
            (m, prefix, path) => {
              if (path.startsWith('//') || path.startsWith('/p/')) return m;
              return prefix + PREFIX + path;
            });
          return [rewritten];
        } catch (e) {}
      }
      return args;
    }
    document.write = function (...args) { return origWrite(...rewriteDocWrite(args)); };
    document.writeln = function (...args) { return origWriteln(...rewriteDocWrite(args)); };
  } catch (e) { /* ignore */ }

  // --- window.postMessage + MessageEvent.origin -----------------------
  // Sites use postMessage(data, "https://target") for cross-window
  // communication. The targetOrigin arg "https://target" doesn't match our
  // proxy origin, so the browser silently drops the message.
  //
  // Corrosion's approach: rewrite targetOrigin to the proxy origin (location.origin).
  // Messages deliver because the proxy window IS the same origin. Receivers
  // that do `if (event.origin !== "https://target") return;` succeed because
  // our MessageEvent.origin patch (below) returns the target origin.
  try {
    window.postMessage = function (message, targetOrigin, ...rest) {
      try {
        if (typeof targetOrigin === 'string' && targetOrigin !== '*' && targetOrigin !== '/') {
          // Any non-wildcard, non-self targetOrigin is treated as a cross-origin
          // request. Rewrite to our proxy origin so the message delivers, and
          // the MessageEvent.origin override will rewrite back to the target
          // for the receiver's origin check.
          targetOrigin = location.origin;
        }
      } catch (e) { /* keep */ }
      return ORIG.postMessage(message, targetOrigin, ...rest);
    };
  } catch (e) { /* ignore */ }
  // Also patch MessageEvent.prototype.origin to return the sender's
  // TARGET origin (so receivers can do origin checks against the target,
  // not the proxy).
  try {
    const originDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin');
    if (originDesc && originDesc.get) {
      Object.defineProperty(MessageEvent.prototype, 'origin', {
        get() {
          const real = originDesc.get.call(this);
          // If the real origin is our proxy, unwrap to the target.
          try {
            if (real === location.origin) return TARGET_ORIGIN;
          } catch (e) {}
          return real;
        },
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }

  // --- window.opener / window.parent / window.top ---------------------
  // Sites check window.opener !== null to know if they were opened by
  // another page. The opener window's location reads as proxy origin.
  // Our $proxyGet$ handles `window.parent`/`window.top` reads, but
  // sites also do `window.opener.location`. We can't fully emulate the
  // opener's location, but we can at least intercept reads.
  // (This is a known limitation — full emulation requires the opener
  // to also be proxied, in which case it'd have its own proxy-client.js.)

  // --- document.domain override ---------------------------------------
  // Setting document.domain throws in modern browsers (Chrome 106+).
  // Some legacy sites still try. Override the setter to silently accept
  // values whose eTLD+1 matches the target.
  try {
    Object.defineProperty(document, 'domain', {
      get() { return targetUrl ? targetUrl.hostname : location.hostname; },
      set(val) {
        // Silently accept — do nothing (modern browsers throw, but legacy
        // code catches and ignores the error anyway).
      },
      configurable: true,
    });
  } catch (e) { /* ignore */ }

  // --- CSSStyleDeclaration.setProperty + background-image etc. ---------
  // JS can set el.style.backgroundImage = "url('/foo')" or
  // el.style.setProperty('background-image', "url('/foo')"). Rewrite.
  try {
    function rewriteCssUrlInValue(val) {
      if (!val || typeof val !== 'string') return val;
      return val.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, q, u) => {
        if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return full;
        try { return `url(${q}${rewriteUrl(u)}${q})`; }
        catch (e) { return full; }
      });
    }
    const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
      try {
        if (typeof value === 'string' && /url\(/i.test(value)) {
          value = rewriteCssUrlInValue(value);
        }
      } catch (e) { /* keep */ }
      return origSetProperty.call(this, name, value, priority);
    };
    // Override background-image / list-style-image / border-image-source /
    // mask-image / -webkit-* etc. descriptors.
    const CSS_URL_PROPS = ['backgroundImage', 'listStyleImage', 'borderImageSource', 'maskImage', 'WebkitMaskImage', 'background'];
    for (const prop of CSS_URL_PROPS) {
      const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop)
        || Object.getOwnPropertyDescriptor(CSS2Properties.prototype, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
        get: d.get ? function () { return d.get.call(this); } : undefined,
        set: function (val) {
          try {
            if (typeof val === 'string' && /url\(/i.test(val)) {
              val = rewriteCssUrlInValue(val);
            }
          } catch (e) { /* keep */ }
          return d.set.call(this, val);
        },
        enumerable: true,
        configurable: true,
      });
    }
  } catch (e) { /* ignore */ }

  // --- Worker / SharedWorker / importScripts --------------------------
  // new Worker('/sw.js') — rewrite the URL. Same for SharedWorker.
  // For blob: workers (`new Worker(URL.createObjectURL(blob))`), we can't
  // synchronously rewrite the blob source (Worker is a sync constructor).
  // We could try a sync XHR to fetch the blob content, but that's
  // deprecated in modern browsers. The server-side JS rewriter + worker
  // bootstrap already prepends the proxy runtime to all worker scripts
  // loaded via URL (not blob:), which handles the common case. For blob
  // workers, we accept the limitation.
  try {
    const OrigWorker = window.Worker;
    if (OrigWorker) {
      function PatchedWorker(scriptURL, options) {
        try {
          if (typeof scriptURL === 'string') scriptURL = rewriteUrl(scriptURL);
        } catch (e) { /* keep */ }
        return new OrigWorker(scriptURL, options);
      }
      PatchedWorker.prototype = OrigWorker.prototype;
      window.Worker = PatchedWorker;
    }
  } catch (e) { /* ignore */ }
  try {
    const OrigSharedWorker = window.SharedWorker;
    if (OrigSharedWorker) {
      function PatchedSharedWorker(scriptURL, options) {
        try {
          if (typeof scriptURL === 'string') scriptURL = rewriteUrl(scriptURL);
        } catch (e) { /* keep */ }
        return new OrigSharedWorker(scriptURL, options);
      }
      PatchedSharedWorker.prototype = OrigSharedWorker.prototype;
      window.SharedWorker = PatchedSharedWorker;
    }
  } catch (e) { /* ignore */ }

  // --- Worklet.addModule (audio worklets) ---------------------------
  // AudioWorklet / PaintWorklet / AnimationWorklet use addModule('/foo.js')
  // to load their scripts. Rewrite the URL.
  try {
    if (window.Worklet && Worklet.prototype && Worklet.prototype.addModule) {
      const origAddModule = Worklet.prototype.addModule;
      Worklet.prototype.addModule = function (moduleURL, options) {
        try {
          if (typeof moduleURL === 'string') moduleURL = rewriteUrl(moduleURL);
        } catch (e) { /* keep */ }
        return origAddModule.call(this, moduleURL, options);
      };
    }
  } catch (e) { /* ignore */ }

  // --- DOMParser.prototype.parseFromString ---------------------------
  // Sites use `new DOMParser().parseFromString(htmlStr, 'text/html')` to
  // parse HTML strings. The parsed document's URLs need rewriting.
  try {
    const origParseFromString = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function (string, type) {
      try {
        if (typeof string === 'string' && typeof type === 'string' &&
            (type.includes('text/html') || type.includes('xml'))) {
          string = rewriteHtmlString(string);
        }
      } catch (e) { /* keep */ }
      return origParseFromString.call(this, string, type);
    };
  } catch (e) { /* ignore */ }

  // --- new Function(...) -------------------------------------------
  // `new Function("return fetch('/foo')")()` would bypass the AST
  // rewriter. Patch Function to rewrite URL strings in the body.
  try {
    const OrigFunction = window.Function;
    function PatchedFunction(...args) {
      try {
        if (args.length > 0 && typeof args[args.length - 1] === 'string') {
          args[args.length - 1] = rewriteUrlStringsInJS(args[args.length - 1]);
        }
      } catch (e) { /* keep */ }
      return new OrigFunction(...args);
    }
    PatchedFunction.prototype = OrigFunction.prototype;
    window.Function = PatchedFunction;
  } catch (e) { /* ignore */ }

  // --- window.eval -------------------------------------------------
  // `eval("location.href = '/foo'")` bypasses the AST rewriter. Patch
  // to rewrite URL strings in the eval body.
  try {
    const origEval = window.eval;
    window.eval = function (code) {
      try {
        if (typeof code === 'string') {
          code = rewriteUrlStringsInJS(code);
        }
      } catch (e) { /* keep */ }
      return origEval.call(window, code);
    };
  } catch (e) { /* ignore */ }

  // --- Function.prototype.toString (anti-detection) ----------------
  // Sites detect patched functions via `fn.toString().includes('native code')`.
  // Our patched functions don't have native code strings, so detection fails.
  // Wrap toString to return a fake "native code" string for our patches.
  try {
    const origFnToString = Function.prototype.toString;
    const NATIVE_STRING = 'function () { [native code] }';
    const patchedFns = new WeakSet();
    // Mark our patched functions with a tag so we can identify them.
    function markPatched(fn) { try { patchedFns.add(fn); } catch (e) {} return fn; }
    // Mark all our patches:
    try { markPatched(window.fetch); } catch (e) {}
    try { markPatched(XMLHttpRequest.prototype.open); } catch (e) {}
    try { markPatched(window.postMessage); } catch (e) {}
    try { markPatched(window.URL); } catch (e) {}
    try { markPatched(navigator.sendBeacon); } catch (e) {}
    try { markPatched(Element.prototype.setAttribute); } catch (e) {}
    try { markPatched(Element.prototype.getAttribute); } catch (e) {}
    try { markPatched(Element.prototype.insertAdjacentHTML); } catch (e) {}
    try { markPatched(Node.prototype.cloneNode); } catch (e) {}
    try { markPatched(window.Worker); } catch (e) {}
    try { markPatched(window.SharedWorker); } catch (e) {}
    try { markPatched(window.Audio); } catch (e) {}
    try { markPatched(window.eval); } catch (e) {}
    try { markPatched(window.Function); } catch (e) {}
    try { markPatched(CSSStyleSheet.prototype.insertRule); } catch (e) {}
    try { markPatched(CSSStyleDeclaration.prototype.setProperty); } catch (e) {}
    try { markPatched(DOMParser.prototype.parseFromString); } catch (e) {}
    try { markPatched(history.pushState); } catch (e) {}
    try { markPatched(history.replaceState); } catch (e) {}
    try { markPatched(window.open); } catch (e) {}
    try { markPatched(Element.prototype.setAttributeNS); } catch (e) {}
    try { markPatched(window.WebSocket); } catch (e) {}
    try { markPatched(window.EventSource); } catch (e) {}
    Function.prototype.toString = function () {
      if (patchedFns.has(this)) return NATIVE_STRING;
      return origFnToString.call(this);
    };
    try { markPatched(Function.prototype.toString); } catch (e) {}
  } catch (e) { /* ignore */ }

  // --- Object.getOwnPropertyNames / getOwnPropertyDescriptors --------
  // Hide our `__proxy-*` sidecar attributes from code that enumerates
  // an element's own properties (otherwise libraries that diff DOM
  // state would see them and may break).
  try {
    const origGetOwnPropertyNames = Object.getOwnPropertyNames;
    Object.getOwnPropertyNames = function (obj) {
      const names = origGetOwnPropertyNames.call(this, obj);
      if (obj && obj.nodeType === 1 && Array.isArray(names)) {
        return names.filter(n => !n.startsWith('__proxy-'));
      }
      return names;
    };
  } catch (e) { /* ignore */ }
  try {
    const origGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
    if (origGetOwnPropertyDescriptors) {
      Object.getOwnPropertyDescriptors = function (obj) {
        const descs = origGetOwnPropertyDescriptors.call(this, obj);
        if (obj && obj.nodeType === 1 && descs) {
          for (const key of Object.keys(descs)) {
            if (key.startsWith('__proxy-')) delete descs[key];
          }
        }
        return descs;
      };
    }
  } catch (e) { /* ignore */ }

  // --- HTMLAnchorElement.prototype.protocol/host/hostname/etc. ------
  // These have their own descriptors on HTMLAnchorElement.prototype.
  // `a.hostname` returns the hostname parsed from the actual href attribute
  // = the proxy host. Sites that do `if (a.hostname === "lichess.org")`
  // fail. Override all six URL-component descriptors to return
  // target-parsed values from the sidecar.
  try {
    const URL_COMPONENT_PROPS = ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
    function patchUrlComponent(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get) return;
      Object.defineProperty(proto, prop, {
        get() {
          let href;
          try {
            const sidecar = ORIG.getAttribute.call(this, '__proxy-href');
            if (sidecar != null) href = sidecar;
            else {
              const actual = ORIG.getAttribute.call(this, 'href');
              if (typeof actual === 'string') href = unwrapUrl(actual) || actual;
              else href = d.get.call(this);
            }
          } catch (e) {
            return d.get.call(this);
          }
          try {
            const u = new URL(href, TARGET_ORIGIN);
            return u[prop];
          } catch (e) {
            return d.get.call(this);
          }
        },
        set(val) {
          try {
            let href;
            const sidecar = ORIG.getAttribute.call(this, '__proxy-href');
            if (sidecar != null) href = sidecar;
            else {
              const actual = ORIG.getAttribute.call(this, 'href');
              if (typeof actual === 'string') href = unwrapUrl(actual) || actual;
              else href = TARGET_ORIGIN + '/';
            }
            const u = new URL(href, TARGET_ORIGIN);
            u[prop] = val;
            ORIG.setAttribute.call(this, '__proxy-href', u.href);
            return ORIG.setAttribute.call(this, 'href', rewriteUrl(u.href));
          } catch (e) {
            return d.set ? d.set.call(this, val) : undefined;
          }
        },
        enumerable: true,
        configurable: true,
      });
    }
    for (const proto of [HTMLAnchorElement.prototype, HTMLAreaElement.prototype, HTMLLinkElement.prototype]) {
      if (!proto) continue;
      for (const prop of URL_COMPONENT_PROPS) {
        patchUrlComponent(proto, prop);
      }
    }
  } catch (e) { /* ignore */ }

  // --- rewriteUrlStringsInJS helper --------------------------------
  // Helper used by eval / Function patches. Rewrites /foo absolute
  // paths to /p/<encoded>/foo in a JS string (in a basic way).
  function rewriteUrlStringsInJS(js) {
    if (!js || typeof js !== 'string') return js;
    return js.replace(/(['"`])(\/[a-zA-Z0-9_\-\/\?\#\&\=\.\:\@\!\$\~\*\+\%\,]+)/g, (m, quote, path) => {
      if (path.startsWith('//')) return m;
      if (path.startsWith('/p/')) return m;
      return quote + PREFIX + path;
    });
  }

  // --- navigator.serviceWorker.register -------------------------------
  // Service Workers would intercept ALL fetches on the proxy origin —
  // which is exactly what we want, but the SW script URL needs rewriting,
  // and the scope needs to be '/'. SWs are complex; for now, just rewrite
  // the script URL and scope.
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      const origRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function (scriptURL, options) {
        try {
          if (typeof scriptURL === 'string') scriptURL = rewriteUrl(scriptURL);
          if (options && typeof options.scope === 'string') {
            options.scope = rewriteUrl(options.scope);
          }
        } catch (e) { /* keep */ }
        return origRegister(scriptURL, options);
      };
    }
  } catch (e) { /* ignore */ }

  // --- Storage (localStorage / sessionStorage) per-origin namespacing --
  // Many sites store session data in localStorage with keys like "session"
  // or "user". If multiple proxy targets share the same proxy origin, their
  // localStorage collides. Prefix storage keys with the target origin so
  // each target has its own namespace.
  try {
    const NS = '__proxy_' + ENCODED + '_';
    for (const storageName of ['localStorage', 'sessionStorage']) {
      const storage = window[storageName];
      if (!storage) continue;
      const origGetItem = storage.getItem.bind(storage);
      const origSetItem = storage.setItem.bind(storage);
      const origRemoveItem = storage.removeItem.bind(storage);
      const origKey = storage.key.bind(storage);
      storage.getItem = function (key) {
        return origGetItem(NS + key);
      };
      storage.setItem = function (key, value) {
        return origSetItem(NS + key, value);
      };
      storage.removeItem = function (key) {
        return origRemoveItem(NS + key);
      };
      storage.key = function (index) {
        // Adjust index — only count namespaced keys.
        const allKeys = Object.keys(storage).filter(k => k.startsWith(NS));
        if (index < 0 || index >= allKeys.length) return null;
        return allKeys[index].slice(NS.length);
      };
    }
  } catch (e) { /* ignore */ }

  // --- MutationObserver for dynamically inserted elements ------------
  try {
    const ATTRIBS = {
      A: ['href', 'ping'],
      IMG: ['src', 'srcset', 'data-src', 'data-srcset', 'data-original', 'data-lazy-src'],
      SCRIPT: ['src'],
      LINK: ['href', 'imagesrcset', 'imagesizes'],
      IFRAME: ['src'],
      SOURCE: ['src', 'srcset'],
      FORM: ['action'],
      VIDEO: ['src', 'poster'],
      AUDIO: ['src'],
      EMBED: ['src'],
      OBJECT: ['data'],
      AREA: ['href', 'ping'],
      INPUT: ['formaction', 'src'],
      BUTTON: ['formaction'],
      TRACK: ['src'],
      // SVG: <use href>, <image href>
      USE: ['href', 'xlink:href'],
      IMAGE: ['href', 'xlink:href'],
      // Lazy-loading libraries
      DIV: ['data-bg', 'data-background', 'data-src', 'data-lazy', 'data-original'],
      SECTION: ['data-bg', 'data-background'],
      ARTICLE: ['data-bg', 'data-background'],
      LI: ['data-bg', 'data-background'],
      SPAN: ['data-bg', 'data-background'],
    };

    // Rewrite srcset value with descriptor-aware splitting.
    // Per spec, srcset is "url descriptor, url descriptor, ..." where the
    // descriptor is "1x", "2x", "100w", etc. URLs can contain commas (e.g.
    // Cloudflare's cdn-cgi/image URLs), so a naive comma split breaks them.
    // Strategy: scan the string; a comma is an entry separator ONLY if the
    // next non-space token starts a new URL (/, ./, ../, https?:, //, or
    // any non-space char). Otherwise the comma is part of the URL.
    function rewriteSrcset(value) {
      if (!value) return value;
      const parts = [];
      let i = 0;
      while (i < value.length) {
        // Skip whitespace.
        while (i < value.length && /\s/.test(value[i])) i++;
        if (i >= value.length) break;
        // Read one entry.
        let j = i;
        let entry = '';
        while (j < value.length) {
          const ch = value[j];
          if (ch === ',') {
            // Look ahead: is the next non-space a URL start?
            let k = j + 1;
            while (k < value.length && /\s/.test(value[k])) k++;
            const nextIsUrlStart = k < value.length && !/[\s,]/.test(value[k]);
            if (nextIsUrlStart) {
              // This comma is a separator.
              break;
            }
            // Part of the URL (Cloudflare cdn-cgi URLs contain commas).
            entry += ch;
            j++;
          } else {
            entry += ch;
            j++;
          }
        }
        entry = entry.trim();
        if (entry) {
          // Split into URL + descriptor (last whitespace before a descriptor).
          // Descriptor is \d+(x|w).
          const m = entry.match(/^(.+?)\s+(\d+(?:\.\d+)?(?:x|w))$/i);
          let url, descriptor;
          if (m) {
            url = m[1];
            descriptor = m[2];
          } else {
            url = entry;
            descriptor = '';
          }
          const rewritten = rewriteUrl(url);
          parts.push(descriptor ? `${rewritten} ${descriptor}` : rewritten);
        }
        i = j + 1;
      }
      return parts.join(', ');
    }

    function rewriteNode(root) {
      if (!root || root.nodeType !== 1) return;
      const stack = [root];
      while (stack.length) {
        const el = stack.pop();
        if (!el || el.nodeType !== 1) continue;
        const attribs = ATTRIBS[el.tagName];
        if (attribs) {
          for (const attr of attribs) {
            if (!el.hasAttribute(attr)) continue;
            const v = el.getAttribute(attr);
            if (!v) continue;
            if (attr === 'srcset' || attr === 'data-srcset' || attr === 'imagesrcset') {
              const r = rewriteSrcset(v);
              if (r !== v) el.setAttribute(attr, r);
            } else {
              const r = rewriteUrl(v);
              if (r !== v) el.setAttribute(attr, r);
            }
          }
        }
        // Also rewrite inline style="url(...)" attributes.
        if (el.hasAttribute && el.hasAttribute('style')) {
          const s = el.getAttribute('style');
          if (s && s.includes('url(')) {
            const r = s.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, q, u) => {
              if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return full;
              const rewritten = rewriteUrl(u);
              return `url(${q}${rewritten}${q})`;
            });
            if (r !== s) el.setAttribute('style', r);
          }
        }
        // Recurse into children + shadow roots if accessible.
        if (el.children && el.children.length) {
          for (let i = 0; i < el.children.length; i++) stack.push(el.children[i]);
        }
        // Walk into open shadow roots (Lit, Shoelace, web components).
        if (el.shadowRoot) {
          stack.push(el.shadowRoot);
          // shadowRoot.children are Element nodes (nodeType 1) — walk them.
          for (let i = 0; i < el.shadowRoot.children.length; i++) {
            stack.push(el.shadowRoot.children[i]);
          }
        }
      }
    }

    // Run the initial rewrite SYNCHRONOUSLY (the script is at the top of
    // <head>, so most of <body> isn't parsed yet — but anything already in
    // <head> like <link>, <meta> needs rewriting before the browser fetches
    // it). Run again on DOMContentLoaded for the rest of the body.
    rewriteNode(document.documentElement);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => rewriteNode(document.documentElement));
    }

    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        // New nodes added.
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) rewriteNode(node);
        }
        // Attribute changes on existing elements (e.g. el.setAttribute('src', '/foo')
        // that somehow bypassed our patched setAttribute — defensive).
        if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
          rewriteNode(m.target);
        }
      }
    });
    // attributes: true + attributeOldValue: false to catch attribute changes.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'src', 'action', 'formaction', 'data', 'poster',
        'srcset', 'imagesrcset', 'cite', 'use', 'image', 'background',
        'data-src', 'data-href', 'data-url', 'data-bg', 'data-original',
        'data-lazy-src', 'data-srcset', 'xlink:href', 'integrity', 'nonce'],
    });
  } catch (e) { /* ignore */ }
})();
