// Realistic browser fingerprint headers.
//
// Bot detectors profile the User-Agent, the sec-ch-ua client hints, the
// Accept-* headers and the Sec-Fetch-* context headers. A naked Node.js
// http-proxy request looks nothing like a real browser, so we override the
// outbound headers to mimic a recent Chrome on Windows.

// Recent stable Chrome channel on Windows 10. Bot detectors accept this
// combination and the format is current. Update the version periodically.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SEC_CH_UA =
  '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';

// Default header set sent by Chrome on a top-level navigation. Individual
// routes can override these (e.g. for XHR/fetch the Accept changes).
const NAVIGATION_HEADERS = {
  'user-agent': USER_AGENT,
  'sec-ch-ua': SEC_CH_UA,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'priority': 'u=0, i',
};

// Header allow-list for outbound requests. Anything in here that we set
// ourselves takes precedence over whatever the browser sent to our proxy
// (which would have our domain in Sec-Fetch-Site / Origin / Referer etc.).
const OVERRIDE_HEADERS = [
  'user-agent',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'accept-language',
  'accept-encoding',
];

// Headers the browser sends that leak our proxy identity or contradict the
// fingerprint we want to project. Strip them from outgoing requests.
const STRIP_OUTGOING = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-server',
  'x-real-ip',
  'via',
  'forwarded',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-cluster-client-ip',
]);

// Map content-type-ish hints to Sec-Fetch-Dest values. We use the request
// Accept header to guess what kind of resource the browser is fetching so
// we send the matching Sec-Fetch-Dest / Sec-Fetch-Mode pair.
function inferFetchContext(req) {
  const accept = (req.headers['accept'] || '').toLowerCase();
  const secFetchDest = req.headers['sec-fetch-dest'] || '';
  const secFetchMode = req.headers['sec-fetch-mode'] || '';

  // Top-level document navigation: browser sends accept: text/html
  if (accept.includes('text/html') && accept.includes('application/xhtml+xml')) {
    return {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    };
  }

  // CSS
  if (accept.includes('text/css') || accept.includes('*/*') === false && accept.startsWith('text/css')) {
    return { 'sec-fetch-dest': 'style', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' };
  }

  // Script
  if (secFetchDest === 'script' || accept.includes('javascript') || accept.includes('*/*') === false && accept.includes('application/javascript')) {
    return { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' };
  }

  // Image
  if (accept.startsWith('image/')) {
    return { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' };
  }

  // Font
  if (accept.includes('font') || secFetchDest === 'font') {
    return { 'sec-fetch-dest': 'font', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' };
  }

  // Default to fetch/XHR: empty dest, cors mode (most APIs), same-origin site.
  // If the client explicitly marked it as cors, keep that.
  return {
    'sec-fetch-dest': secFetchDest || 'empty',
    'sec-fetch-mode': secFetchMode || 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

// Build the final outbound header set for a proxied request.
// - Removes proxy-leak headers.
// - Overrides UA / sec-ch-ua / Accept-Language / Accept-Encoding with the
//   realistic Chrome values.
// - Recomputes Sec-Fetch-* based on the Accept header so they match what
//   a real browser would send for that kind of resource.
// - Rewrites Referer / Origin / Host so the target sees a same-origin request.
function buildOutboundHeaders(req, targetUrl, prefix, cookieHeader) {
  const headers = { ...req.headers };

  // 1. Drop proxy-leak headers.
  for (const name of STRIP_OUTGOING) delete headers[name];

  // 2. Drop our own routing-specific headers that don't belong to the target.
  delete headers['host'];
  delete headers['referer'];
  delete headers['origin'];
  delete headers['cookie'];

  // 3. Override the fingerprint headers.
  for (const name of OVERRIDE_HEADERS) {
    headers[name] = NAVIGATION_HEADERS[name];
  }

  // 4. Add Host matching the target (http-proxy-middleware with changeOrigin
  //    would do this anyway, but we want to be explicit so it survives any
  //    future onProxyReq hook reordering).
  headers['host'] = targetUrl.host;

  // 5. Compute Sec-Fetch-* context for this resource type.
  const ctx = inferFetchContext(req);
  for (const [k, v] of Object.entries(ctx)) headers[k] = v;

  // 6. Synthesize a same-origin Referer. The browser sent us a Referer of
  //    https://our-proxy.com/p/<encoded>/<oldpath> -- the target site would
  //    reject this as cross-site. Rewrite to <target-origin>/<oldpath>.
  const incomingReferer = req.headers['referer'];
  if (incomingReferer) {
    try {
      const refUrl = new URL(incomingReferer);
      if (refUrl.pathname.startsWith(prefix + '/') || refUrl.pathname === prefix) {
        const innerPath = refUrl.pathname.slice(prefix.length) || '/';
        headers['referer'] = targetUrl.origin + innerPath + (refUrl.search || '') + (refUrl.hash || '');
      } else {
        // Browser-sent Referer doesn't look like a proxy URL; fall back to the
        // target origin so we don't leak our domain to the target.
        headers['referer'] = targetUrl.origin + '/';
      }
    } catch {
      headers['referer'] = targetUrl.origin + '/';
    }
  }

  // 7. Synthesize an Origin header for CORS requests. The browser sends
  //    Origin: https://our-proxy.com. Target would reject this. Rewrite to
  //    the target origin so the request looks same-origin.
  const incomingOrigin = req.headers['origin'];
  if (incomingOrigin) {
    headers['origin'] = targetUrl.origin;
  }

  // 8. Attach cookies from our server-side jar (the browser's own cookies are
  //    scoped to our domain, not the target, and won't include subdomain-
  //    scoped cookies the target set via Domain=...; we manage them ourselves).
  if (cookieHeader) headers['cookie'] = cookieHeader;

  return headers;
}

module.exports = {
  USER_AGENT,
  NAVIGATION_HEADERS,
  buildOutboundHeaders,
  inferFetchContext,
};
