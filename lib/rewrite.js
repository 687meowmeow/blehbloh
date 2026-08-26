// URL + body rewriting helpers.
//
// The proxy rewrites references to the target origin (and any of its
// subdomains) so they go back through /p/<base64(origin)>/. Each subdomain
// gets its OWN encoded prefix -- lichess.org and socket.lichess.org are
// treated as separate origins and proxied independently, so cookies and
// sessions don't bleed across subdomains in the wrong direction.

function encodeOrigin(origin) {
  return Buffer.from(origin, 'utf8').toString('base64url');
}
function decodeOrigin(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compute the eTLD+1 (best-effort, no public suffix list): drop the
// leftmost subdomain label. For "lichess.org" returns "lichess.org",
// for "socket.lichess.org" returns "lichess.org", for "a.b.lichess.org"
// returns "lichess.org". Used to decide whether two hosts belong to the
// same site (so we rewrite links between subdomains through the proxy).
function apexOf(host) {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

// Match https?://subdomain.host or https?://host. Returns the full origin
// string (e.g. "https://socket.lichess.org") for the matched match.
const ABS_RE = (host) =>
  new RegExp(`https?:\\/\\/(?:[a-zA-Z0-9-]+\\.)*${escapeRegex(host)}`, 'g');

// Match ws(s)://subdomain.host or ws(s)://host.
const WS_RE = (host) =>
  new RegExp(`wss?:\\/\\/(?:[a-zA-Z0-9-]+\\.)*${escapeRegex(host)}`, 'g');

// Match protocol-relative //subdomain.host or //host, but only when preceded
// by a boundary that suggests it's actually a URL (quote, equals, paren,
// whitespace). This avoids clobbering things like "1 // 2" in JS comments.
const REL_RE = (host) =>
  new RegExp(`([\\s"'(=,;])\\/\\/(?:[a-zA-Z0-9-]+\\.)*${escapeRegex(host)}`, 'g');

// Given an absolute match like "https://socket.lichess.org", return the
// proxy path prefix for that exact origin.
function absToProxy(match) {
  try {
    const u = new URL(match);
    return `/p/${encodeOrigin(u.origin)}`;
  } catch {
    return match; // leave untouched on parse failure
  }
}

// Given a ws(s):// match, return a ws(s)://our-proxy-host/p/<encoded>/ URL.
function wsToProxy(match, proxyHost) {
  const proto = match.startsWith('wss') ? 'wss' : 'ws';
  const httpProto = proto === 'wss' ? 'https' : 'http';
  try {
    const u = new URL(httpProto + '://' + match.replace(/^wss?:\/\//, ''));
    return `${proto}://${proxyHost}/p/${encodeOrigin(u.origin)}`;
  } catch {
    return match;
  }
}

// Rewrite a single URL string (used for Location / Refresh / Link headers).
// Returns the proxied URL if it points at the target or one of its subdomains,
// otherwise the original string unchanged.
function rewriteSingleUrl(url, targetUrl, proxyHost) {
  if (!url || typeof url !== 'string') return url;

  // Absolute https?://
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      const apex = apexOf(u.hostname);
      if (apex === apexOf(targetUrl.hostname)) {
        return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      }
    } catch {}
    return url;
  }

  // Protocol-relative //host
  if (url.startsWith('//')) {
    try {
      const u = new URL('https:' + url);
      const apex = apexOf(u.hostname);
      if (apex === apexOf(targetUrl.hostname)) {
        return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      }
    } catch {}
    return url;
  }

  // Relative URL: prepend the proxy prefix so the browser navigates inside
  // the proxy instead of treating it as a path on our domain.
  // e.g. Location: /login -> /p/<encoded>/login
  if (url.startsWith('/')) {
    return `/p/${encodeOrigin(targetUrl.origin)}` + url;
  }

  // ws(s):// -- shouldn't appear in Location headers, but be safe.
  if (/^wss?:\/\//i.test(url)) {
    const proto = url.startsWith('wss') ? 'wss' : 'ws';
    const httpProto = proto === 'wss' ? 'https' : 'http';
    try {
      const u = new URL(url.replace(/^wss?:\/\//i, httpProto + '://'));
      const apex = apexOf(u.hostname);
      if (apex === apexOf(targetUrl.hostname)) {
        return `${proto}://${proxyHost}/p/${encodeOrigin(proto === 'wss' ? 'https://' + u.host : 'http://' + u.host)}${u.pathname}${u.search}${u.hash}`;
      }
    } catch {}
    return url;
  }

  return url;
}

// Rewrite an HTML / CSS / JS / JSON body so any URL pointing at the target
// (or its subdomains) goes back through the proxy.
function rewriteTextBody(text, targetUrl, proxyHost) {
  if (!text || typeof text !== 'string') return text;

  // 1. Absolute https://host URLs (incl. subdomains).
  text = text.replace(ABS_RE(targetUrl.hostname), absToProxy);

  // 2. ws(s)://host URLs (incl. subdomains) -> ws(s)://our-host/p/<encoded>/.
  text = text.replace(WS_RE(targetUrl.hostname), (m) => wsToProxy(m, proxyHost));

  // 3. Protocol-relative //host URLs. We assume https for the rewrite.
  text = text.replace(
    REL_RE(targetUrl.hostname),
    (m, lead) => lead + absToProxy('https://' + m.slice(lead.length).replace(/^\/\//, ''))
  );

  return text;
}

// Inject a <base> tag and the client-side patch script at the top of <head>.
// The base tag makes relative URLs resolve correctly inside the proxy. The
// script patches fetch/XHR/history/window.open so runtime-generated URLs
// also stay inside the proxy.
function injectIntoHtml(text, encoded, targetOrigin) {
  const prefix = `/p/${encoded}`;
  const injectBase = `<base href="${prefix}/">`;
  const injectScript =
    `<script src="/proxy-client.js" data-target-origin="${targetOrigin}" ` +
    `data-encoded="${encoded}" data-prefix="${prefix}"></script>`;

  if (/<head[^>]*>/i.test(text)) {
    return text.replace(/<head[^>]*>/i, (m) => `${m}${injectBase}${injectScript}`);
  }
  if (/<html[^>]*>/i.test(text)) {
    return text.replace(/<html[^>]*>/i, (m) => `${m}<head>${injectBase}${injectScript}</head>`);
  }
  return `${injectBase}${injectScript}${text}`;
}

module.exports = {
  encodeOrigin,
  decodeOrigin,
  escapeRegex,
  apexOf,
  rewriteSingleUrl,
  rewriteTextBody,
  injectIntoHtml,
};
