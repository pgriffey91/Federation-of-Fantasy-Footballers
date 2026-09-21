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

  // League hard salary cap (per the rulebook: $500, all-in after the
  // startup draft + in-season FAAB budget).
  hardCap: 500,

  // Trades can retain up to this much salary on the sending team per the
  // rulebook's "you can receive up to $50 of cap space every year" rule.
  maxRetainedSalary: 50,

  // Your league's Google Sheet salary ledger. Sharing must be set to
  // "Anyone with the link -> Viewer" for this to work (Share button in
  // Google Sheets), since the site reads it live via Google's CSV export.
  googleSheetId: "1qa67_YFLOFr2Ng6g56IdrzP3wQueUuZ1-ZCaeKsHG6s",

  // The tab with the leaguewide Salary Cap / Dead Cap totals.
  snapshotSheetName: "Salary Cap Snapshot",

  // Maps each Sleeper roster_id to that team's tab name in the sheet above.
  // Edit this if a team's sheet tab gets renamed or ownership changes.
  sheetTabsByRosterId: {
    "1": "Dwpurcell",
    "2": "pgriffey91",
    "3": "IrishSox15",
    "4": "tklatka",
    "5": "JoeFro",
    "6": "BigBob847",
    "7": "Rdoro24",
    "8": "saellingsen1",
    "9": "BrotherDan2",
    "10": "AlexMira24",
  },
};
