/* Weekly fantasy-points lookup, used for the "Best Value" leaderboard
 * (points scored per dollar of salary). Sleeper's per-week stats endpoint
 * returns every player's stat line for that week in one call, so we loop
 * weeks the same way app.js loops transactions and sum pts_half_ppr.
 *
 * This is an approximation, not your league's exact scoring: it uses
 * Sleeper's built-in half-PPR total rather than recomputing your league's
 * specific scoring settings play-by-play. Good enough to rank "value",
 * not meant to match your weekly box scores exactly.
 */

const StatsData = (() => {
  const API = "https://api.sleeper.app/v1";

  async function loadSeasonPoints(season, maxWeek) {
    const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
    const totals = new Map(); // player_id -> total pts_half_ppr
    const weekly = new Map(); // player_id -> Map(week -> pts_half_ppr), used for trend leaderboards
    // Sleeper's stats API has no snap-count data at all (checked every field
    // on a player's weekly stat line — there's no off_snp/def_snp/snap % of
    // any kind), so games-actually-played (Sleeper's own `gp` flag) is the
    // closest available proxy for "was this guy actually active," used to
    // keep injured/inactive players who scored 0 out of the Biggest Busts
    // leaderboard.
    const gamesPlayed = new Map(); // player_id -> count of weeks with gp === 1

    const CONCURRENCY = 6;
    for (let i = 0; i < weeks.length; i += CONCURRENCY) {
      const slice = weeks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((w) =>
          fetch(`${API}/stats/nfl/regular/${season}/${w}`)
            .then((r) => (r.ok ? r.json() : {}))
            .then((data) => ({ week: w, data }))
            .catch(() => ({ week: w, data: {} }))
        )
      );
      for (const { week, data } of results) {
        for (const [playerId, stat] of Object.entries(data || {})) {
          if (!stat || typeof stat.pts_half_ppr !== "number") continue;
          totals.set(playerId, (totals.get(playerId) || 0) + stat.pts_half_ppr);
          if (!weekly.has(playerId)) weekly.set(playerId, new Map());
          weekly.get(playerId).set(week, stat.pts_half_ppr);
          if (stat.gp === 1) gamesPlayed.set(playerId, (gamesPlayed.get(playerId) || 0) + 1);
        }
      }
    }
    return { totals, weekly, gamesPlayed };
  }

  return { loadSeasonPoints };
})();
