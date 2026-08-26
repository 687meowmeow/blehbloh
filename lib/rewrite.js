// URL + body rewriting helpers.
//
// The proxy rewrites references to ANY absolute URL (http:// or https://) so
// they go back through /p/<base64(origin)>/. Each origin gets its OWN encoded
// prefix -- lichess.org and lichess1.org are treated as separate origins and
// proxied independently.
//
// Absolute-path URLs (e.g. "/api/foo") get rewritten to /p/<encoded>/api/foo
// because the injected <base href="/p/<encoded>/"> tag does NOT affect
// absolute paths (per RFC 3986, an absolute path replaces the base's path
// entirely).

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

// Negative-lookahead boundary so we don't match "replit.com.evil.com".
const HOST_BOUNDARY = '(?![a-zA-Z0-9.-])';

// Match ANY https?://...absolute URL with its full path/query/hash. We
// rewrite ALL of them through the proxy, regardless of whether they point
// to the target origin or a sibling origin (lichess1.org, cdn.replit.com,
// identitytoolkit.googleapis.com, etc). This is more aggressive than v4
// but is the only way to handle modern SPAs that fan out across many
// sibling origins.
// Strategy: match the scheme, hostname, port, then everything up to the
// next whitespace, quote, paren, or angle bracket.
const ANY_ABS_RE = /https?:\/\/(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(?::\d+)?(?:\/[^\s"'<>]*)?/g;

// Match ws(s)://...absolute URL with full path.
const ANY_WS_RE = /wss?:\/\/(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(?::\d+)?(?:\/[^\s"'<>]*)?/g;

// Match protocol-relative //host[:port]/path. We capture the host+path up to
// the next whitespace, quote, paren, or end. The leading boundary ensures
// we only match in URL contexts (not JS comments like "// note").
const REL_RE = /([\s"'(=,;])\/\/(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(?::\d+)?(\/[^\s"'()<>]*)?/g;

// Given an absolute match like "https://socket.lichess.org", return the
// proxy path PREFIX (just /p/<encoded>). The caller adds the path/query.
function absToProxyPrefix(match) {
  try {
    const u = new URL(match);
    return `/p/${encodeOrigin(u.origin)}`;
  } catch {
    return match; // leave untouched on parse failure
  }
}

// Given a ws(s):// match, return a ws(s)://our-proxy-host/p/<encoded>/ URL
// (just the prefix; caller adds path/query).
function wsToProxyPrefix(match, proxyHost) {
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
function rewriteSingleUrl(url, targetUrl, proxyHost) {
  if (!url || typeof url !== 'string') return url;

  // Absolute https?://
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
    } catch { return url; }
  }

  // Protocol-relative //host
  if (url.startsWith('//')) {
    try {
      const u = new URL('https:' + url);
      return `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
    } catch { return url; }
  }

  // Absolute path: prepend the target's proxy prefix so the browser
  // navigates inside the proxy instead of treating it as a path on our
  // domain. e.g. Location: /login -> /p/<encoded>/login
  if (url.startsWith('/') && !url.startsWith('//')) {
    return `/p/${encodeOrigin(targetUrl.origin)}` + url;
  }

  // ws(s)://
  if (/^wss?:\/\//i.test(url)) {
    const proto = url.startsWith('wss') ? 'wss' : 'ws';
    const httpProto = proto === 'wss' ? 'https' : 'http';
    try {
      const u = new URL(url.replace(/^wss?:\/\//i, httpProto + '://'));
      return `${proto}://${proxyHost}/p/${encodeOrigin(u.origin)}${u.pathname === '/' ? '/' : u.pathname}${u.search || ''}${u.hash || ''}`;
    } catch { return url; }
  }

  return url;
}

// HTML attributes that hold URL values. We rewrite absolute paths (/foo) to
// /p/<encoded>/foo in any of these. NOTE: srcset/imagesrcset are handled
// SEPARATELY (see step 4b) because they can contain multiple URLs with
// descriptors, separated by commas.
const URL_ATTR_RE = new RegExp(
  '(' +
    '\\b(?:href|src|action|poster|formaction|data-src|data-href|data-url|' +
    'data-action|data-bg|data-original|data-lazy|data-lazy-src|data-poster|' +
    'data-share-url|data-download-url|' +
    'manifest|cite|longdesc|usemap|profile|background|archive|codebase|' +
    'classid|icon|content|ping|use|image|imagesizes|' +
    'xlink:href)' +
    '\\s*=\\s*["\']' +
  ')' +
  '(\\/[^"\'\\s>]*)',
  'gi'
);

// srcset/imagesrcset/data-srcset need their own regex because they contain
// multiple URLs separated by commas. We capture the full quoted value and
// run rewriteSrcsetValue on it.
const SRCSET_ATTR_RE = /((?:srcset|imagesrcset|data-srcset)\s*=\s*)(["'])([^"']*)\2/gi;

// CSS url(...) rewriter. Used for text/css content and inline <style> blocks.
// Matches url('...'), url("..."), and url(...) (unquoted). Skips data:, blob:,
// #, mailto:, and already-proxied /p/... URLs.
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function rewriteCssUrls(css, targetUrl, encoded) {
  if (!css || typeof css !== 'string') return css;
  const prefix = `/p/${encoded}`;
  return css.replace(CSS_URL_RE, (full, quote, url) => {
    url = url.trim();
    // Skip non-URL values.
    if (!url) return full;
    if (url.startsWith('data:')) return full;
    if (url.startsWith('blob:')) return full;
    if (url.startsWith('#')) return full;
    if (url.startsWith('mailto:')) return full;
    if (url.startsWith('tel:')) return full;
    if (url.startsWith('javascript:')) return full;
    // Skip already-proxied.
    if (url.startsWith('/p/')) return full;
    // Skip protocol-relative //host (handled by main rewriter if needed).
    if (url.startsWith('//')) return full;

    // Absolute https?:// -> /p/<encoded-of-that-origin>/path
    if (/^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url);
        const out = `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
        return `url(${quote}${out}${quote})`;
      } catch { return full; }
    }

    // Absolute path -> /p/<target-encoded>/path
    if (url.startsWith('/')) {
      return `url(${quote}${prefix}${url}${quote})`;
    }

    // Relative URL: leave it (CSS resolution will handle it via the file's
    // own URL, which is already proxied).
    return full;
  });
}

// Rewrite srcset / imagesrcset value. Split on descriptor-aware boundaries:
// the value is comma-separated "url descriptor, url descriptor" pairs.
// The URL can contain commas (e.g. Cloudflare's cdn-cgi/image URLs).
// Strategy: split on `,\s*` followed by something that looks like a URL
// boundary + descriptor. Per spec, each entry is "url descriptor" where
// descriptor is "1x", "2x", "100w", etc. We split on `,\s*(?=\S+\s+\d+(?:x|w)\b)`
// — but that's hard to express in JS regex. Simpler: find URLs + descriptors
// via a regex tokenizer.
const SRCSET_ENTRY_RE = /(\S+(?:\s+\d+(?:x|w))?)\s*(?:,|$)/g;

function rewriteSrcsetValue(value, targetUrl, proxyHost, encoded) {
  if (!value || typeof value !== 'string') return value;
  const prefix = `/p/${encoded}`;
  // Match: URL followed by optional descriptor, separated by commas.
  // We use a manual scanner because URLs can contain commas.
  const parts = [];
  let i = 0;
  while (i < value.length) {
    // Skip whitespace.
    while (i < value.length && /\s/.test(value[i])) i++;
    if (i >= value.length) break;
    // Read until comma (top-level) -- but commas inside URLs are tricky.
    // Per spec, commas in srcset URLs should be %2C-encoded, but Cloudflare
    // doesn't encode them. We treat a comma NOT followed by whitespace + a
    // new URL as part of the current URL.
    let j = i;
    let entry = '';
    while (j < value.length) {
      const ch = value[j];
      if (ch === ',' ) {
        // Look ahead: is the next non-space a URL start? If so, this comma
        // is an entry separator. Otherwise it's part of the URL.
        let k = j + 1;
        while (k < value.length && /\s/.test(value[k])) k++;
        // A new entry starts with /, ./, ../, https?:, //, or a scheme:
        // (e.g. mailto:). Anything else (like "quality=") is part of the
        // current URL. This handles Cloudflare's cdn-cgi/image URLs which
        // contain un-encoded commas.
        const rest = value.slice(k);
        const nextIsUrlStart = /^\.\.\//.test(rest) || /^\.\//.test(rest)
          || /^https?:/i.test(rest) || /^\/\//.test(rest)
          || /^\//.test(rest) || /^[a-z][a-z0-9+.-]*:/i.test(rest);
        if (nextIsUrlStart) {
          // This comma is a separator.
          break;
        } else {
          // Part of the URL.
          entry += ch;
          j++;
        }
      } else {
        entry += ch;
        j++;
      }
    }
    entry = entry.trim();
    if (entry) {
      // Split into URL + descriptor (last whitespace).
      const lastSpace = entry.lastIndexOf(' ');
      let url, descriptor;
      if (lastSpace >= 0 && /\d+(?:x|w)$/.test(entry.slice(lastSpace + 1))) {
        url = entry.slice(0, lastSpace).trim();
        descriptor = entry.slice(lastSpace + 1);
      } else {
        url = entry;
        descriptor = '';
      }
      // Rewrite the URL.
      let rewritten;
      if (/^https?:\/\//i.test(url)) {
        try {
          const u = new URL(url);
          rewritten = `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
        } catch { rewritten = url; }
      } else if (url.startsWith('//')) {
        try {
          const u = new URL('https:' + url);
          rewritten = `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
        } catch { rewritten = url; }
      } else if (url.startsWith('/') && !url.startsWith('/p/')) {
        rewritten = prefix + url;
      } else {
        rewritten = url;
      }
      parts.push(descriptor ? `${rewritten} ${descriptor}` : rewritten);
    }
    i = j + 1;
  }
  return parts.join(', ');
}

// Rewrite an HTML / CSS / JS / JSON body so any URL goes back through the proxy.
// `targetUrl` is the apex target's URL object; `encoded` is its base64 origin.
// `proxyHost` is our proxy's host (for ws:// URLs).
function rewriteTextBody(text, targetUrl, proxyHost, encoded) {
  if (!text || typeof text !== 'string') return text;
  const prefix = `/p/${encoded}`;

  // 1. Absolute https?:// URLs (ANY origin, not just target).
  //    We need to preserve trailing path/query. Use a manual scanner since
  //    RegExp match-and-replace with new URL parsing is fiddly.
  text = text.replace(ANY_ABS_RE, (match) => {
    try {
      const u = new URL(match);
      const out = `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      return out;
    } catch { return match; }
  });

  // 2. ws(s):// URLs (ANY origin).
  text = text.replace(ANY_WS_RE, (match) => {
    const proto = match.startsWith('wss') ? 'wss' : 'ws';
    const httpProto = proto === 'wss' ? 'https' : 'http';
    try {
      const u = new URL(httpProto + '://' + match.replace(/^wss?:\/\//, ''));
      return `${proto}://${proxyHost}/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
    } catch { return match; }
  });

  // 3. Protocol-relative //host URLs. Rewrite to /p/<encoded-of-host>/path.
  //    REL_RE captures the path as group 2 (optional).
  text = text.replace(REL_RE, (m, lead, path) => {
    try {
      const u = new URL('https:' + m.slice(lead.length));
      const out = `/p/${encodeOrigin(u.origin)}` + (u.pathname === '/' && !path ? '/' : u.pathname) + (u.search || '') + (u.hash || '');
      return lead + out;
    } catch { return m; }
  });

  // 4. Absolute-path URLs in HTML attributes: /foo -> /p/<encoded>/foo.
  //    Skip if already proxied (starts with /p/).
  text = text.replace(URL_ATTR_RE, (match, attrPrefix, path) => {
    if (path.startsWith('//')) return match; // protocol-relative
    if (path.startsWith('/p/')) return match; // already proxied
    return `${attrPrefix}${prefix}${path}`;
  });

  // 4b. srcset / imagesrcset / data-srcset: multi-URL attributes. Use the
  //     descriptor-aware splitter so we don't mangle Cloudflare cdn-cgi URLs
  //     that contain commas.
  text = text.replace(SRCSET_ATTR_RE, (match, attrPrefix, quote, value) => {
    const rewritten = rewriteSrcsetValue(value, targetUrl, proxyHost, encoded);
    return `${attrPrefix}${quote}${rewritten}${quote}`;
  });

  // 4b. Meta refresh: <meta http-equiv="refresh" content="0; url=/foo">
  //     The content attribute starts with "0; url=" not "/". Handle separately.
  text = text.replace(
    /(<meta\s+http-equiv=["']refresh["'][^>]*\bcontent=["'])([^"']*?)(["'])/gi,
    (m, lead, val, quote) => {
      // val is like "0; url=/foo" or "0; url=https://target/foo"
      const rewritten = val.replace(
        /url=([^"'\s]+)/gi,
        (m2, url) => 'url=' + rewriteSingleUrl(url, targetUrl, proxyHost)
      );
      return lead + rewritten + quote;
    }
  );

  // 5. CSS url() inside inline <style> blocks. (External CSS is rewritten
  //    by the same rewriteTextBody call when the .css file is proxied, but
  //    CSS files don't have HTML attribute patterns; they're pure CSS.)
  //    For inline <style>...</style>, run rewriteCssUrls on the content.
  text = text.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, body) => {
    return `<style${attrs}>` + rewriteCssUrls(body, targetUrl, encoded) + '</style>';
  });

  // 6. Style="..." attributes (inline CSS).
  text = text.replace(/(\sstyle=)["']([^"']*)["']/gi, (m, attr, body) => {
    return attr + '"' + rewriteCssUrls(body, targetUrl, encoded) + '"';
  });

  return text;
}

// Inject a <base> tag and the client-side patch script at the top of <head>.
// Also strip <meta http-equiv="Content-Security-Policy"> and -Report-Only
// tags from the body — the response header is already stripped in server.js,
// but the meta tag survives and blocks our same-origin rewriting (Lichess
// uses a meta CSP that blocks the proxied WS URLs).
function injectIntoHtml(text, encoded, targetOrigin) {
  const prefix = `/p/${encoded}`;
  const injectBase = `<base href="${prefix}/">`;
  const injectScript =
    `<script src="/proxy-client.js" data-target-origin="${targetOrigin}" ` +
    `data-encoded="${encoded}" data-prefix="${prefix}"></script>`;

  // 1. Remove existing <base> tags (their href would be wrong after our
  //    rewrites and would override ours per the HTML spec).
  text = text.replace(/<base\b[^>]*>/gi, '');

  // 2. Strip <meta http-equiv="Content-Security-Policy"> and
  //    <meta http-equiv="Content-Security-Policy-Report-Only"> tags.
  //    These would block our same-origin rewriting (CSP path matching is
  //    strict; our /p/<encoded>/<path> URLs don't match the rewritten
  //    sources in the policy).
  text = text.replace(
    /<meta\s+http-equiv=["']Content-Security-Policy(?:-Report-Only)?["'][^>]*>/gi,
    ''
  );

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
  rewriteCssUrls,
  rewriteSrcsetValue,
  injectIntoHtml,
};
