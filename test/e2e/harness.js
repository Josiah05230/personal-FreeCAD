/* Injected before every scenario. Runs IN THE RENDERER, so `window`,
 * `window.__gwtcad`, `window.cad` are all live. Provides:
 *   assert(cond, msg), assertEq(a, b, msg)
 *   sleep(ms), waitFor(fn, ms), idle()  - idle() waits for the command queue + engine to settle
 *   G                                    - shorthand for window.__gwtcad
 *   rpc(method, params)                  - shorthand for window.cad.rpc
 *   rng(seed)                            - deterministic PRNG -> () => float in [0,1)
 * A scenario pushes results via pass()/fail() and the harness returns the tally.
 */
// the bridge object is swapped on every React render - always read through to
// the current one rather than capturing a stale reference
const G = new Proxy(
  {},
  {
    get: (_t, k) => {
      const v = window.__gwtcad[k];
      return typeof v === 'function' ? v.bind(window.__gwtcad) : v;
    }
  }
);
const rpc = (m, p) => window.cad.rpc(m, p || {});
/** whitelisted shell env forwarded by the --e2e harness (FUZZ_* / MONKEY_* / E2E_*) */
const ENV = (typeof window !== 'undefined' && window.__E2E_ENV) || {};
// nobody is here to click a native modal - auto-answer so a run never blocks
try {
  window.confirm = () => true;
  window.alert = () => {};
} catch (_e) {
  /* ignore */
}
const _lines = [];
let _passed = 0,
  _failed = 0;
let _n = 0;

function pass(msg) {
  _passed++;
  _lines.push(`ok ${++_n} - ${msg}`);
}
function fail(msg) {
  _failed++;
  _lines.push(`not ok ${++_n} - ${msg}`);
}
function assert(cond, msg) {
  cond ? pass(msg) : fail(msg);
  return !!cond;
}
function assertEq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass(`${msg} (= ${JSON.stringify(a)})`) : fail(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
  return ok;
}
function note(msg) {
  _lines.push(`# ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}
/** two rAF ticks = React has committed the last render + run its effects, so
 * window.__gwtcad.getState() is a fresh closure over current state */
const flush = () =>
  new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

/** wait until the command queue is drained, the engine pings, and React settled */
async function idle(ms = 15000) {
  const ok = await waitFor(() => !window.__gwtcad.getState().busy, ms);
  await rpc('ping').catch(() => {});
  await flush();
  await sleep(20);
  await flush();
  return ok;
}
/** mulberry32 - deterministic so a failing monkey run reproduces from its seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
