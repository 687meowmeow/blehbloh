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
  try {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function (state, title, url) {
      if (url) {
        const r = rewriteUrl(String(url));
        return origPush(state, title, r);
      }
      return origPush(state, title);
    };
    history.replaceState = function (state, title, url) {
      if (url) {
        const r = rewriteUrl(String(url));
        return origReplace(state, title, r);
      }
      return origReplace(state, title);
    };
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
  // Catch clicks on <a> tags whose href is an absolute URL pointing at the
  // target origin (or subdomain). The server-side rewriter handles static
  // anchors in the HTML; this catches anchors that the page's JS inserted
  // later.
  document.addEventListener('click', function (e) {
    let node = e.target;
    while (node && node !== document.body) {
      if (node.tagName === 'A' && node.href) {
        const rewritten = rewriteUrl(node.href);
        if (rewritten !== node.href) {
          // We must use setAttribute so the browser re-resolves href.
          node.setAttribute('href', rewritten);
          // Re-check after the attribute change; if the browser still has
          // the old absolute URL cached in .href, force a navigation.
          if (node.href && !node.href.startsWith(PREFIX)) {
            e.preventDefault();
            location.href = rewritten;
          }
        }
        break;
      }
      node = node.parentNode;
    }
  }, true);

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
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) rewriteNode(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }
})();
