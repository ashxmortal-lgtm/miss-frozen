/* Frozen Blooded — seven-day claim streak model (presentation only).
   Rules are the bot's own (same ones ExFrozen uses):
     · day keys are IST dates (UTC+5:30), supplied by the server as `today`
     · a claim on the day after the last claim moves the streak forward
     · any longer gap resets the streak to day 1
     · after day 7 the cycle restarts at day 1
   The server still validates and pays every claim; this file only decides
   which day cell is "done", "ready" and "upcoming". */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBStreak = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CYCLE = 7;
  // tgcloud/lib/economy.js reward amounts (unchanged).
  const DAY_COINS = 500;
  const DAY_CHAKRA = 100;
  const BONUS_COINS = 1000; // day 7 only
  const BONUS_CHAKRA = 200; // day 7 only

  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  function dateKey(value) {
    return typeof value === 'string' && DATE.test(value) ? value : null;
  }

  function addDays(key, days) {
    const base = dateKey(key);
    if (!base) return null;
    const [y, m, d] = base.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    at.setUTCDate(at.getUTCDate() + days);
    return at.toISOString().slice(0, 10);
  }

  function narrowStreak(value) {
    const n = Math.trunc(Number(value) || 0);
    if (n < 0) return 0;
    return n > CYCLE ? n % CYCLE === 0 ? CYCLE : n % CYCLE : n;
  }

  function rewardFor(day) {
    const bonus = day === CYCLE;
    return {
      day,
      coins: DAY_COINS + (bonus ? BONUS_COINS : 0),
      chakra: DAY_CHAKRA + (bonus ? BONUS_CHAKRA : 0),
      bonus,
    };
  }

  /**
   * @param {{streak:number, lastClaim:string, today:string}} input
   * @returns {{
   *   claimedToday:boolean, claimedDay:number, nextDay:number|null,
   *   completed:number, progressPct:number, missed:boolean, cycleComplete:boolean,
   *   days:Array<{day:number,state:string,reward:object}>, headline:string, note:string
   * }}
   */
  function view(input) {
    const today = dateKey(input && input.today);
    const lastClaim = dateKey(input && input.lastClaim);
    const yesterday = today ? addDays(today, -1) : null;
    const streak = narrowStreak(input && input.streak);

    const claimedToday = !!(today && lastClaim === today);
    const missed = !!(today && lastClaim && lastClaim !== today && lastClaim !== yesterday);

    let claimedDay = 0;
    let nextDay = null;
    if (claimedToday) {
      claimedDay = Math.max(1, streak);
    } else if (today && lastClaim === yesterday) {
      nextDay = (streak % CYCLE) + 1;
    } else {
      nextDay = 1;
    }

    const days = [];
    for (let day = 1; day <= CYCLE; day += 1) {
      let state = 'upcoming';
      if (claimedToday) {
        if (day < claimedDay) state = 'done';
        else if (day === claimedDay) state = 'claimed';
      } else if (day < nextDay) {
        state = 'done';
      } else if (day === nextDay) {
        state = 'ready';
      }
      days.push({ day, state, reward: rewardFor(day) });
    }

    const completed = claimedToday ? claimedDay : nextDay - 1;
    const cycleComplete = claimedToday && claimedDay === CYCLE;

    let headline;
    let note;
    if (claimedToday) {
      headline = cycleComplete
        ? 'Seven-day cycle complete'
        : 'Day ' + claimedDay + ' claimed';
      note = cycleComplete
        ? 'The next claim starts a fresh day 1 tomorrow.'
        : 'Next claim unlocks after 12:00 AM IST.';
    } else if (missed) {
      headline = 'Streak reset';
      note = 'A day was missed, so the next claim starts again at day 1.';
    } else if (lastClaim === yesterday) {
      headline = 'Day ' + nextDay + ' is ready';
      note = 'Claim today to keep the streak alive.';
    } else {
      headline = 'Day 1 is ready';
      note = 'Claim today to start a seven-day streak.';
    }

    return {
      claimedToday,
      claimedDay,
      nextDay,
      completed,
      progressPct: Math.round((completed / CYCLE) * 100),
      missed,
      cycleComplete,
      days,
      headline,
      note,
      streak,
      cycle: CYCLE,
    };
  }

  return {
    CYCLE,
    DAY_COINS,
    DAY_CHAKRA,
    BONUS_COINS,
    BONUS_CHAKRA,
    rewardFor,
    view,
    addDays,
    dateKey,
    narrowStreak,
  };
});
