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

  // Rewrite a single URL string to its proxied form, if it points at the
  // target or any subdomain of the target. Returns the original string
  // unchanged otherwise.
  function rewriteUrl(url) {
    if (!url || typeof url !== 'string') return url;

    // Already proxied.
    if (url.startsWith(PREFIX)) return url;

    // Absolute URL to the target or one of its subdomains.
    if (/^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url, TARGET_ORIGIN);
        const apex = apexOf(u.hostname);
        if (apex === TARGET_APEX) {
          return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
        }
      } catch { return url; }
      return url;
    }

    // Protocol-relative //target/path
    if (url.startsWith('//')) {
      try {
        const u = new URL('https:' + url);
        const apex = apexOf(u.hostname);
        if (apex === TARGET_APEX) {
          return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
        }
      } catch {}
      return url;
    }

    // ws(s)://...target...
    if (/^wss?:\/\//i.test(url)) {
      try {
        const proto = url.startsWith('wss') ? 'wss' : 'ws';
        const httpProto = proto === 'wss' ? 'https' : 'http';
        const u = new URL(url.replace(/^wss?:\/\//i, httpProto + '://'));
        const apex = apexOf(u.hostname);
        if (apex === TARGET_APEX) {
          return `${proto}://${location.host}/p/${encodeOrigin(proto === 'wss' ? 'https://' + u.host : 'http://' + u.host)}${u.pathname}${u.search}${u.hash}`;
        }
      } catch {}
      return url;
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
  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === 'string') {
            input = rewriteUrl(input);
          } else if (input && input.url) {
            // Request object
            input = new Request(rewriteUrl(input.url), input);
          }
        } catch (e) { /* fall through with original input */ }
        return origFetch.call(this, input, init);
      };
    }
  } catch (e) { /* ignore */ }

  // --- XMLHttpRequest.open() ------------------------------------------
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { url = rewriteUrl(String(url)); } catch (e) { /* keep */ }
      return origOpen.call(this, method, url, ...rest);
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
  // server-side HTML rewriter can't catch it. Patch the constructor.
  try {
    const OrigWebSocket = window.WebSocket;
    function PatchedWebSocket(url, protocols) {
      try {
        if (typeof url === 'string') url = rewriteUrl(url);
        else if (url && url.url) url = rewriteUrl(url.url);
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
  try {
    const OrigES = window.EventSource;
    if (OrigES) {
      function PatchedES(url, config) {
        try { if (typeof url === 'string') url = rewriteUrl(url); } catch (e) { /* keep */ }
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
      A: ['href'],
      IMG: ['src', 'srcset'],
      SCRIPT: ['src'],
      LINK: ['href'],
      IFRAME: ['src'],
      SOURCE: ['src', 'srcset'],
      FORM: ['action'],
      VIDEO: ['src', 'poster'],
      AUDIO: ['src'],
      EMBED: ['src'],
      OBJECT: ['data'],
      AREA: ['href'],
    };

    function rewriteSrcset(value) {
      if (!value) return value;
      // srcset is comma-separated: "url 1x, url 2x"
      return value
        .split(',')
        .map(part => {
          const trimmed = part.trim();
          const sp = trimmed.indexOf(' ');
          const u = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
          const r = rewriteUrl(u);
          return sp >= 0 ? r + trimmed.slice(sp) : r;
        })
        .join(', ');
    }

    function rewriteNode(root) {
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
            if (attr === 'srcset') {
              el.setAttribute(attr, rewriteSrcset(v));
            } else if (attr === 'action') {
              el.setAttribute(attr, rewriteUrl(v));
            } else {
              const r = rewriteUrl(v);
              if (r !== v) el.setAttribute(attr, r);
            }
          }
        }
        // recurse into children
        if (el.children && el.children.length) {
          for (let i = 0; i < el.children.length; i++) stack.push(el.children[i]);
        }
      }
    }

    // First pass: rewrite what's already in the DOM at script-injection time.
    // (The script is in <head>, so most of the body isn't parsed yet; the
    // MutationObserver below catches the rest as it streams in.)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => rewriteNode(document.documentElement));
    } else {
      rewriteNode(document.documentElement);
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
