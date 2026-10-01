export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** 83 -> "1:23", 3700 -> "1:01:40" */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1:30" | "90" | "1m30s" | "+10" -> { value, relative } (seconds) */
export function parseTime(str) {
  if (!str) return null;
  str = String(str).trim();
  let relative = false;
  let sign = 1;
  if (/^[+-]/.test(str)) {
    relative = true;
    sign = str[0] === '-' ? -1 : 1;
    str = str.slice(1);
  }
  let value = null;
  if (/^\d+(:\d+){1,2}$/.test(str)) {
    value = str.split(':').reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
  } else if (/^\d+(\.\d+)?$/.test(str)) {
    value = parseFloat(str);
  } else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(str);
    if (m && (m[1] || m[2] || m[3])) value = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }
  if (value === null) return null;
  return { value: value * sign, relative };
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
