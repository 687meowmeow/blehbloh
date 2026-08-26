// Server-side cookie jar.
//
// Why: the browser stores cookies scoped to our proxy domain (because we
// strip Domain= from Set-Cookie). That works for simple sites, but breaks
// for sites that rely on cross-subdomain cookies. Lichess, for example,
// authenticates WebSocket connections to socket.lichess.org using the
// session cookie that was set on lichess.org with Domain=lichess.org. If we
// let the browser manage cookies, the WebSocket request to socket.lichess.org
// arrives with no cookies and gets bounced as unauthenticated.
//
// Solution: keep the cookies on the server, indexed by domain. On every
// outbound request, attach cookies that match the request's host and path.
// Strip Set-Cookie from responses we forward to the browser so the browser
// doesn't double-manage them.

class CookieJar {
  constructor() {
    // domain -> Map<name, { value, path, expires, secure, httpOnly }>
    this.byDomain = new Map();
  }

  _domainStore(domain) {
    let m = this.byDomain.get(domain);
    if (!m) {
      m = new Map();
      this.byDomain.set(domain, m);
    }
    return m;
  }

  // Parse one or more Set-Cookie header values and store them.
  set(setCookie, requestHost) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];

    for (const raw of list) {
      const parts = raw.split(';').map(s => s.trim());
      if (!parts.length) continue;
      const nameValue = parts[0];
      const eq = nameValue.indexOf('=');
      if (eq < 0) continue;
      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1).trim();
      if (!name) continue;

      let domain = requestHost;
      let path = '/';
      let expires = null;
      let secure = false;
      let httpOnly = false;

      for (let i = 1; i < parts.length; i++) {
        const attr = parts[i];
        const lower = attr.toLowerCase();
        if (lower.startsWith('domain=')) {
          domain = attr.slice(7).trim().replace(/^\./, '');
        } else if (lower.startsWith('path=')) {
          path = attr.slice(5).trim() || '/';
        } else if (lower.startsWith('expires=')) {
          const t = Date.parse(attr.slice(8).trim());
          if (!isNaN(t)) expires = t;
        } else if (lower === 'secure') {
          secure = true;
        } else if (lower === 'httponly') {
          httpOnly = true;
        } else if (lower.startsWith('max-age=')) {
          const secs = parseInt(attr.slice(8).trim(), 10);
          if (!isNaN(secs)) expires = Date.now() + secs * 1000;
        }
      }

      const store = this._domainStore(domain);
      if (expires !== null && expires <= Date.now()) {
        store.delete(name);
      } else {
        store.set(name, { value, path, expires, secure, httpOnly });
      }
    }
  }

  // Return a Cookie header string for a request to `host` + `path`, or null.
  get(host, path, isSecure) {
    const now = Date.now();
    const parts = [];

    for (const [domain, store] of this.byDomain) {
      const matchesDomain = host === domain || host.endsWith('.' + domain);
      if (!matchesDomain) continue;

      for (const [name, c] of store) {
        if (c.expires !== null && c.expires < now) continue;
        if (c.secure && !isSecure) continue;
        // Path matching: cookie path is a prefix of request path, OR both
        // are "/".
        if (c.path && c.path !== '/' && !path.startsWith(c.path)) continue;
        parts.push(`${name}=${c.value}`);
      }
    }

    return parts.length ? parts.join('; ') : null;
  }

  // Sync cookies the browser sent to us back into the server jar.
  //
  // Why: JS on the page can set cookies via `document.cookie = "name=value"`.
  // The browser stores them scoped to the proxy host (because the page URL
  // is /p/<encoded>/...). When the browser sends them on the next request,
  // we receive them in req.headers.cookie. We need to merge them into the
  // server-side jar so they flow through to the upstream target.
  //
  // Strategy: for each cookie the browser sent, if it's not in the jar (for
  // this domain) or the value differs, update the jar. Use default attributes
  // (Path=/, no Secure, no HttpOnly) since the browser-sent Cookie header
  // carries no attributes.
  syncFromBrowser(cookieHeader, targetHost) {
    if (!cookieHeader) return;
    // Parse "name1=value1; name2=value2" into pairs.
    const pairs = cookieHeader.split(';').map(s => s.trim());
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;

      // Look up the cookie in any matching domain store.
      let found = false;
      for (const [domain, store] of this.byDomain) {
        const matchesDomain = targetHost === domain || targetHost.endsWith('.' + domain);
        if (!matchesDomain) continue;
        const existing = store.get(name);
        if (existing) {
          if (existing.value !== value) {
            // JS updated the cookie value; keep the jar in sync.
            existing.value = value;
          }
          found = true;
          break;
        }
      }
      if (!found) {
        // JS created a new cookie; add it under the target host.
        const store = this._domainStore(targetHost);
        store.set(name, { value, path: '/', expires: null, secure: false, httpOnly: false });
      }
    }
  }

  // Clear cookies for a domain (used on demand via an admin route).
  clear(domain) {
    if (domain) this.byDomain.delete(domain);
    else this.byDomain.clear();
  }
}

module.exports = { CookieJar };
