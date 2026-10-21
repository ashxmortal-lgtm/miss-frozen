/**
 * IST time helpers — shared by /inventory, Gate, patrol/mission dispatch,
 * training and Tsunade search messages. IST = UTC + 5:30, no DST.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function istParts(unixSec) {
  const d = new Date(unixSec * 1000 + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hh: String(d.getUTCHours()).padStart(2, '0'),
    mm: String(d.getUTCMinutes()).padStart(2, '0'),
    ss: String(d.getUTCSeconds()).padStart(2, '0'),
  };
}

/** "18:45" */
export function istHm(unixSec) {
  const p = istParts(unixSec);
  return `${p.hh}:${p.mm}`;
}

/** "18 Oct, 18:45 IST" (day+month always shown so next-day completions are clear). */
export function istDateTime(unixSec) {
  const p = istParts(unixSec);
  return `${p.day} ${MONTHS[p.month]}, ${p.hh}:${p.mm} IST`;
}

/** "18 Oct 2026, 18:45 IST" — for spans that may cross years. */
export function istDateTimeFull(unixSec) {
  const p = istParts(unixSec);
  return `${p.day} ${MONTHS[p.month]} ${p.year}, ${p.hh}:${p.mm} IST`;
}

/**
 * Same-day comparison in IST: is `unixSec` on the same IST calendar day as now?
 * Used to drop the date prefix when a completion happens today.
 */
export function isToday(unixSec, nowSec = Math.floor(Date.now() / 1000)) {
  const a = new Date(unixSec * 1000 + IST_OFFSET_MS);
  const b = new Date(nowSec * 1000 + IST_OFFSET_MS);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

/** Time until `unixSec` as "in 18m 24s" / "in 1h 05m" / "in 2d 3h". */
export function inRemaining(unixSec, nowSec = Math.floor(Date.now() / 1000)) {
  let s = Math.max(0, Math.floor(unixSec - nowSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `in ${m}m ${String(sec).padStart(2, '0')}s`;
  return `in ${sec}s`;
}

/**
 * "18:45 IST" when today (IST), otherwise "18 Oct, 18:45 IST".
 * Appends the remaining time when it is still in the future: "(in 18m 24s)".
 */
export function dueText(unixSec, nowSec = Math.floor(Date.now() / 1000)) {
  const stamp = isToday(unixSec, nowSec) ? `${istHm(unixSec)} IST` : istDateTime(unixSec);
  const left = unixSec - nowSec;
  return left > 0 ? `${stamp} (${inRemaining(unixSec, nowSec)})` : stamp;
}
