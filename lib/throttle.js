// Per-origin request throttle.
//
// Two goals:
//  - Don't fire hundreds of requests in the same instant like a scraper.
//  - Keep total throughput low enough that we look like a single human on a
//    single browser tab, not a headless client.
//
// Implementation: a per-origin gate that allows up to `maxConcurrent`
// simultaneous in-flight requests, with a minimum `minSpacing` ms between
// consecutive request starts. Both numbers can be tuned via env vars to make
// the proxy faster or slower.

class OriginGate {
  constructor(maxConcurrent, minSpacing) {
    this.maxConcurrent = maxConcurrent;
    this.minSpacing = minSpacing;
    this.state = new Map(); // origin -> { active, lastStart, queue }
  }

  _state(origin) {
    let s = this.state.get(origin);
    if (!s) {
      s = { active: 0, lastStart: 0, queue: [] };
      this.state.set(origin, s);
    }
    return s;
  }

  _tryDispatch(origin) {
    const s = this._state(origin);
    while (s.queue.length > 0 && s.active < this.maxConcurrent) {
      const now = Date.now();
      const wait = Math.max(0, s.lastStart + this.minSpacing - now);
      if (wait > 0) {
        setTimeout(() => this._tryDispatch(origin), wait + 5);
        return;
      }
      const resolve = s.queue.shift();
      s.active++;
      s.lastStart = Date.now();
      resolve();
    }
  }

  acquire(origin) {
    return new Promise(resolve => {
      const s = this._state(origin);
      s.queue.push(resolve);
      this._tryDispatch(origin);
    });
  }

  release(origin) {
    const s = this._state.get(origin);
    if (!s) return;
    s.active = Math.max(0, s.active - 1);
    this._tryDispatch(origin);
  }
}

// Factory: build a gate from env vars so the user can tune the "slowness".
function gateFromEnv() {
  const maxConcurrent = parseInt(process.env.THROTTLE_MAX_CONCURRENT || '4', 10);
  const minSpacing = parseInt(process.env.THROTTLE_MIN_SPACING_MS || '180', 10);
  return new OriginGate(maxConcurrent, minSpacing);
}

module.exports = { OriginGate, gateFromEnv };
