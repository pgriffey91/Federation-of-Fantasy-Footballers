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

    const CONCURRENCY = 6;
    for (let i = 0; i < weeks.length; i += CONCURRENCY) {
      const slice = weeks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((w) =>
          fetch(`${API}/stats/nfl/regular/${season}/${w}`)
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({}))
        )
      );
      for (const weekStats of results) {
        for (const [playerId, stat] of Object.entries(weekStats || {})) {
          if (!stat || typeof stat.pts_half_ppr !== "number") continue;
          totals.set(playerId, (totals.get(playerId) || 0) + stat.pts_half_ppr);
        }
      }
    }
    return totals; // Map player_id -> total points
  }

  return { loadSeasonPoints };
})();
