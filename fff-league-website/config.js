// League-specific configuration. Edit this file to point the site at your league.
window.LEAGUE_CONFIG = {
  // Sleeper league_id (found in the URL when you open your league on sleeper.com/app)
  leagueId: "1315034161047670784",

  // Site title
  siteName: "Federation of Fantasy Football",

  // Which weeks to pull transactions for. Sleeper transactions are fetched
  // per-week ("leg"), so we loop from week 1 through this max. 18 covers a
  // full regular season + playoffs; raise it if your league plays longer.
  maxWeek: 18,

  // How long to cache the (large, ~5-8MB) Sleeper player database in the
  // browser before refetching, in hours. Sleeper asks that this endpoint
  // not be called more than once a day.
  playerCacheHours: 24,
};
