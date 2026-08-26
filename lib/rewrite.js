// URL + body rewriting helpers.
//
// The proxy rewrites references to the target origin (and any of its
// subdomains) so they go back through /p/<base64(origin)>/. Each subdomain
// gets its OWN encoded prefix -- lichess.org and socket.lichess.org are
// treated as separate origins and proxied independently, so cookies and
// sessions don't bleed across subdomains in the wrong direction.
//
// We also rewrite absolute-path URLs (e.g. "/api/foo") to "/p/<encoded>/api/foo"
// because the injected <base href="/p/<encoded>/"> tag does NOT affect
// absolute paths -- the browser would otherwise send them straight to the
// proxy host (404).

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

// Negative-lookahead char class: matches anything that would NOT extend a
// hostname (so we don't match "replit.com.evil.com" when looking for
// "replit.com"). A hostname can continue with [a-zA-Z0-9.-], so anything
// else is a boundary.
const HOST_BOUNDARY = '(?![a-zA-Z0-9.-])';

// Match https?://subdomain.host[:port]. Returns the full origin string
// (e.g. "https://socket.lichess.org:8443") for the matched match.
// The negative lookahead prevents matching "replit.com.evil.com".
const ABS_RE = (host) =>
  new RegExp(`https?:\\/\\/(?:[a-zA-Z0-9-]+\\.)*${escapeRegex(host)}(?::\\d+)?${HOST_BOUNDARY}`, 'g');

// Match ws(s)://subdomain.host[:port].
const WS_RE = (host) =>
  new RegExp(`wss?:\\/\\/(?:[a-zA-Z0-9-]+\\.)*${escapeRegex(host)}(?::\\d+)?${HOST_BOUNDARY}`, 'g');

// Match protocol-relative //subdomain.host[:port], but only when preceded
// by a boundary that suggests it's actually a URL (quote, equals, paren,
// whitespace). This avoids clobbering things like "1 // 2" in JS comments.
const REL_RE = (host) =>
  new RegExp(`([\\s"'(=,;])\\/\\/(?:[a-zA-Z0-9-]+\\.)*${escapeRegex(host)}(?::\\d+)?${HOST_BOUNDARY}`, 'g');

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

  // Absolute path: prepend the proxy prefix so the browser navigates inside
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

// HTML attributes that hold URL values and where absolute-path URLs (those
// starting with "/" but not "//") need to be rewritten to /p/<encoded>/...
// We don't rewrite anything that already starts with /p/<encoded>/ (already
// proxied), or that has a scheme (mailto:, tel:, data:, blob:, javascript:).
const URL_ATTR_RE = (encoded) =>
  new RegExp(
    '(' +
      '\\b(?:href|src|action|poster|formaction|data-src|data-href|data-url|data-action|' +
      'manifest|cite|longdesc|usemap|profile|background|archive|codebase|classid|icon|' +
      'content)\\s*=\\s*["\']' +
    ')' +
    '(\\/[^"\'\\s>]*)',  // capture: /path... (must start with /)
    'gi'
  );

// Rewrite an HTML / CSS / JS / JSON body so any URL pointing at the target
// (or its subdomains) goes back through the proxy. Also rewrite absolute-
// path URLs in HTML attributes so /foo becomes /p/<encoded>/foo.
function rewriteTextBody(text, targetUrl, proxyHost, encoded) {
  if (!text || typeof text !== 'string') return text;
  const prefix = `/p/${encoded}`;

  // 1. Absolute https://host URLs (incl. subdomains + ports).
  text = text.replace(ABS_RE(targetUrl.hostname), absToProxy);

  // 2. ws(s)://host URLs (incl. subdomains + ports) -> ws(s)://our-host/p/<encoded>/.
  text = text.replace(WS_RE(targetUrl.hostname), (m) => wsToProxy(m, proxyHost));

  // 3. Protocol-relative //host URLs. We assume https for the rewrite.
  text = text.replace(
    REL_RE(targetUrl.hostname),
    (m, lead) => lead + absToProxy('https://' + m.slice(lead.length).replace(/^\/\//, ''))
  );

  // 4. Absolute-path URLs in HTML attributes: /foo -> /p/<encoded>/foo.
  //    Skip if already proxied or has a non-http scheme (mailto:, etc.).
  if (encoded) {
    text = text.replace(URL_ATTR_RE(encoded), (match, attrPrefix, path) => {
      // Skip if path is protocol-relative (//host) — handled by step 3.
      if (path.startsWith('//')) return match;
      // Skip if already proxied.
      if (path.startsWith(prefix + '/') || path === prefix) return match;
      // Skip if it has a scheme like "mailto:", "data:", "blob:", "javascript:", "tel:".
      // (These don't start with /, so this is just defensive.)
      // Actually, URL_ATTR_RE only matches paths starting with /, so we're
      // fine — but exclude paths that look like "/mailto:..." which is bogus.
      // Skip meta refresh content that has a scheme prefix in the path:
      // "content='0; url=/foo'" — the path "/foo" is what we want to rewrite,
      // but if the content is just "0; url=mailto:..." we don't want to
      // rewrite the "url=mailto:..." part. Hmm, this regex doesn't match that
      // because "url=mailto:..." doesn't start with /.
      // So we're safe.
      return `${attrPrefix}${prefix}${path}`;
    });
  }

  return text;
}

// Inject a <base> tag and the client-side patch script at the top of <head>.
// The base tag makes relative URLs resolve correctly inside the proxy. The
// script patches fetch/XHR/history/window.open so runtime-generated URLs
// also stay inside the proxy.
//
// IMPORTANT: remove any existing <base> tags first. The HTML spec says the
// LAST <base> tag wins, so if we just prepend ours, the page's existing
// <base href="..."> would override ours and break relative URLs.
function injectIntoHtml(text, encoded, targetOrigin) {
  const prefix = `/p/${encoded}`;
  const injectBase = `<base href="${prefix}/">`;
  const injectScript =
    `<script src="/proxy-client.js" data-target-origin="${targetOrigin}" ` +
    `data-encoded="${encoded}" data-prefix="${prefix}"></script>`;

  // Remove existing <base> tags (their href would be wrong after our
  // rewrites and would override ours per the HTML spec).
  text = text.replace(/<base\b[^>]*>/gi, '');

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
