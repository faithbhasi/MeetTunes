/**
 * Runs inside every frame of the meeting page (via addInitScript). It watches the chat DOM and reports
 * *new* messages through the exposed `__mtChat` binding.
 *
 * - Messages are keyed by id (when the platform has one) or sender|time|text, with occurrence counting,
 *   so re-rendered/virtualised lists don't replay history while a user repeating "#next" still works.
 * - A generic text scan (text starting with the command prefix, outside anything the platform selectors
 *   own) keeps commands working when a platform changes its markup.
 *
 * NOTE: this function is serialised with toString(); it must stay self-contained.
 */
export function chatObserverInit(spec) {
  if (window.__mt) return;
  const S = (window.__mt = { armed: false, seen: new Map(), specHit: false, spec, timer: null });

  const norm = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const textOf = (el) => norm(el.innerText !== undefined ? el.innerText : el.textContent);

  function collectSpec() {
    const sp = S.spec;
    const out = [];
    if (!sp.message) return out;
    let nodes;
    try {
      nodes = document.querySelectorAll(sp.sender ? sp.message + ',' + sp.sender : sp.message);
    } catch (e) {
      return out;
    }
    let last = '';
    for (const el of nodes) {
      const isMsg = el.matches(sp.message);
      if (sp.sender && !isMsg && el.matches(sp.sender)) {
        last = textOf(el);
        continue;
      }
      let sender = '';
      if (sp.sender) {
        const s = el.matches(sp.sender) ? null : el.querySelector(sp.sender);
        sender = s ? textOf(s) : last;
        if (s) last = sender;
      }
      const t = sp.text ? (el.matches(sp.text) ? el : el.querySelector(sp.text)) : el;
      const body = t ? textOf(t) : '';
      if (!body) continue;
      const time = sp.time ? ((el.querySelector(sp.time) || {}).textContent || '').trim() : '';
      let id = null;
      if (sp.idAttr) {
        const holder = el.hasAttribute(sp.idAttr) ? el : el.closest('[' + sp.idAttr + ']');
        id = holder ? holder.getAttribute(sp.idAttr) : null;
      }
      out.push({ sender, text: body, key: id ? 'id:' + id : sender + '\u0001' + time + '\u0001' + body });
    }
    return out;
  }

  /**
   * Safety net for when the platform selectors are stale: any text node that starts with the command prefix.
   * Text that lives inside an element the platform selector already owns is skipped (no double reports).
   */
  function collectGeneric() {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (!s || s.indexOf(S.spec.prefix) !== 0) continue;
      const p = n.parentElement;
      if (!p || p.closest('input,textarea,script,style,[contenteditable="true"],[contenteditable=""],[role="textbox"]')) continue;
      let owned = false;
      try {
        owned = !!(S.spec.message && p.closest(S.spec.message));
      } catch (e) {
        /* invalid selector override: treat as not owned */
      }
      if (owned) continue;
      out.push({ sender: '', text: s.split('\n')[0], key: 'g\u0001' + s });
    }
    return out;
  }

  function scan(emit) {
    const spec = collectSpec();
    S.specHit = S.specHit || spec.length > 0;
    const items = spec.concat(collectGeneric());
    const counts = new Map();
    for (const it of items) {
      const c = (counts.get(it.key) || 0) + 1;
      counts.set(it.key, c);
      if (c > (S.seen.get(it.key) || 0)) {
        S.seen.set(it.key, c);
        if (emit && typeof window.__mtChat === 'function') {
          try {
            window.__mtChat(JSON.stringify({ sender: it.sender, text: it.text, mode: it.key.charAt(0) === 'g' && it.key.charAt(1) === '\u0001' ? 'generic' : 'dom' }));
          } catch (e) {
            /* binding gone */
          }
        }
      }
    }
  }

  let pending = false;
  const schedule = () => {
    if (pending || !S.armed) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan(true);
    }, 120);
  };

  window.__mtArm = () => {
    if (S.armed) return;
    S.armed = true;
    scan(false);
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    S.timer = setInterval(() => scan(true), 1500);
  };
  // Chat panel was (re)opened: whatever is on screen now is history, not new commands.
  window.__mtRebaseline = () => {
    S.seen.clear();
    scan(false);
  };
  window.__mtSetPrefix = (p) => {
    S.spec.prefix = p;
  };
  window.__mtProbe = () => {
    const spec = collectSpec();
    return { url: location.href.slice(0, 120), specMatches: spec.length, specHit: S.specHit, armed: S.armed, sample: spec.slice(-3) };
  };
}

export const observerInitScript = (spec) => `(${chatObserverInit.toString()})(${JSON.stringify(spec)});`;
