import { sleep } from '../util.js';

/** All frames of a page, main frame first. Meeting clients love iframes. */
export const framesOf = (page) => {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => f !== main)];
};

const asList = (sel) => (Array.isArray(sel) ? sel : [sel]).filter(Boolean);

/** First visible element matching any selector, searching every frame. Returns a Locator or null. */
export async function findVisible(page, selectors) {
  for (const frame of framesOf(page)) {
    for (const sel of asList(selectors)) {
      try {
        const loc = frame.locator(sel);
        const n = Math.min(await loc.count(), 6);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (await el.isVisible()) return el;
        }
      } catch {
        // frame navigated / detached mid-check
      }
    }
  }
  return null;
}

export async function isVisible(page, selectors) {
  return !!(await findVisible(page, selectors));
}

/** Click the first visible match. Returns true if something was clicked. */
export async function clickFirst(page, selectors, { timeout = 4000 } = {}) {
  const el = await findVisible(page, selectors);
  if (!el) return false;
  try {
    await el.click({ timeout });
    return true;
  } catch {
    try {
      await el.click({ timeout: 1500, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Put `value` into the first visible input matching the selectors (only if it differs). */
export async function fillFirst(page, selectors, value) {
  const el = await findVisible(page, selectors);
  if (!el) return false;
  try {
    const current = await el.inputValue({ timeout: 800 }).catch(() => null);
    if (current === value) return false;
    await el.fill(value, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function pollUntil(fn, { timeout = 10000, interval = 400, signal } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled');
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(interval);
  }
}

export function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
