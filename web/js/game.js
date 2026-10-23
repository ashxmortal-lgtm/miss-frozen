/* Frozen Blooded — presentation rules shared by every screen.
   Mirrors the bot's rank table and preserves the bot's original emoji labels.
   Pure functions only: no DOM, no network, no storage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBGame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Same thresholds as tgcloud/lib/activities.js rankOf().
  const RANKS = [
    [0, 'Academy Student'],
    [500, 'Genin'],
    [1500, 'Chūnin'],
    [3500, 'Jōnin'],
    [6500, 'Anbu'],
    [10000, 'Kage'],
  ];

  function fmt(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /** Rank tier + XP progress toward the next rank (mirrors the bot table). */
  function rankProgress(xp) {
    const value = Math.max(0, Number(xp) || 0);
    let index = 0;
    for (let i = 0; i < RANKS.length; i += 1) if (value >= RANKS[i][0]) index = i;
    const [from, rank] = RANKS[index];
    const next = RANKS[index + 1] || null;
    const span = next ? next[0] - from : 0;
    const into = value - from;
    const pct = next ? Math.round((into / span) * 100) : 100;
    return {
      tier: index + 1,
      tiers: RANKS.length,
      rank,
      xp: value,
      from,
      next: next ? next[0] : null,
      nextRank: next ? next[1] : null,
      into,
      span,
      pct: clamp(pct, 0, 100),
      maxed: !next,
      label: next
        ? fmt(value) + ' / ' + fmt(next[0]) + ' XP → ' + next[1]
        : fmt(value) + ' XP · max rank',
    };
  }

  /** Case-insensitive label match. Emojis are left untouched: a bot label such
      as "👁️ Itachi" still matches the stored roster name "Itachi". */
  function matches(label, name) {
    const a = String(label == null ? '' : label).toLowerCase();
    const b = String(name == null ? '' : name).toLowerCase();
    return !!a && !!b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
  }

  /** Commands referenced inside an ability description ("" when none). */
  function commandsIn(text) {
    const found = String(text || '').match(/\/[a-z][a-z_]+/g) || [];
    return [...new Set(found)];
  }

  /** Abilities you trigger with a command are active; the rest are passive. */
  function abilityKind(text) {
    return commandsIn(text).length ? 'active' : 'passive';
  }

  /** First "24h"-style window inside a description, if any. */
  function cooldownIn(text) {
    const m = String(text || '').match(/(\d+)\s*(h|hr|hrs|hour|hours)\b/i);
    return m ? m[1] + 'h' : '';
  }

  function initial(name) {
    const s = String(name || '').trim();
    return s ? s.charAt(0).toUpperCase() : 'S';
  }

  return { RANKS, fmt, clamp, rankProgress, matches, commandsIn, abilityKind, cooldownIn, initial };
});
