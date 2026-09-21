# League Salary Cap Site

A static site (no backend) for a Sleeper dynasty salary-cap league:
a live activity feed (adds with FAAB $, drops, trades, taxi-squad moves),
a Cap Health Matrix, per-team roster pages, value/highest-paid/dead-cap
leaderboards, a trade calculator, a Draft & Free Agency reference page, and
a searchable rule book. Built to be hosted for free on GitHub Pages.

## How it works

- **Adds / drops / trades** are fetched live, in the visitor's browser,
  directly from the [Sleeper API](https://docs.sleeper.com/). No server
  needed — Sleeper's API is public and read-only.
- **Taxi-squad moves** aren't available as a Sleeper API history endpoint —
  it only exposes each roster's *current* taxi list. So a small scheduled
  job (`.github/workflows/track-taxi.yml`) polls that list every 3 hours,
  diffs it against the last snapshot, and commits any new taxi-add /
  taxi-remove events to `data/taxi-log.json`. The site reads that file
  alongside the live Sleeper data.
- **Salaries** (cap health, roster pages, leaderboards, trade calculator)
  come from the league's Google Sheet, read live via Google's CSV export
  (`sheet.js`). Sleeper has no concept of salary at all, so the sheet stays
  the source of truth — the site just mirrors it. This means the site is
  only as current as the sheet: if a manager forgets to update it after a
  drop or trade, the site will show stale numbers until it's updated.
- **"Best Value" leaderboard** uses Sleeper's built-in half-PPR season point
  totals per player, divided by salary. It's an approximation — a ranking
  tool, not a recreation of your league's exact weekly scoring.
- **Trade Machine** is a calculator only; it doesn't submit anything to
  Sleeper. It applies the rulebook's retained-salary math (up to $50) to
  show each team's resulting cap space, but doesn't account for draft picks
  or the $50/year retained-salary cap across multiple trades in a season —
  you're still the judge of whether a hypothetical trade is legal.

## One-time setup

1. **Create a GitHub repo** (public or private — Pages works with either on
   paid plans; public repos get Pages free) and push these files to it,
   preserving the folder structure (`data/`, `scripts/`, and
   `.github/workflows/` must stay as folders, not get flattened).
2. **Share your Google Sheet**: open it → Share (top right) → change
   general access to "Anyone with the link" → Viewer. The site reads it
   read-only via Google's CSV export; this doesn't let anyone edit it.
3. **Edit `config.js`** if anything about your league changes:
   - `leagueId` — your Sleeper league ID (already set for this league).
   - `googleSheetId` — the long ID in your sheet's URL (already set).
   - `sheetTabsByRosterId` — maps each Sleeper roster to its sheet tab name.
     Update this if a team's tab gets renamed or a franchise changes hands.
   - `hardCap` / `maxRetainedSalary` — only if the league's rules change.
4. **Enable GitHub Pages**: repo Settings → Pages → Source → "Deploy from a
   branch" → pick `main` and `/ (root)`. Save. Your site will be live at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.
5. **Enable Actions** (usually on by default): repo Settings → Actions →
   General → allow workflows to run. The taxi-tracker workflow needs
   "Read and write permissions" for `GITHUB_TOKEN` — check Settings →
   Actions → General → Workflow permissions, and set it to "Read and write
   permissions" so it can commit the log file back to the repo.
6. Trigger the taxi tracker once by hand: Actions tab →
   "Track taxi squad moves" → Run workflow. Its first run just records a
   baseline snapshot (no events yet, since there's nothing to diff against);
   from the second run onward, any taxi moves since the last poll show up
   in the feed.

## Pages

- **Home** — header stats (hard cap, trade deadline, season phase), the Cap
  Health Matrix, and the live activity feed with filters.
- **My Team** — pick a team, see its active roster / taxi / IR with salaries.
- **League Rosters** — the same breakdown for every team, collapsed by default.
- **Leaderboards** — Best Value Contracts, Highest Paid Players, Dead Cap Wall.
- **Trade Machine** — pick two teams, select players to send each way, set
  retained salary, see the resulting cap space.
- **Draft & FA** — the rookie salary schedule and free-agency/waiver rules.
- **Rule Book** — the full rulebook with a live search box.

## Adjusting things later

- **Poll frequency**: edit the `cron` line in
  `.github/workflows/track-taxi.yml`. GitHub's minimum practical interval is
  about 5 minutes, but every 1–3 hours is plenty for taxi moves.
- **Season length**: `config.js`'s `maxWeek` controls how many weeks of
  transactions/stats the site pulls (default 18, covering regular season +
  playoffs).
- **Rule book text**: edit `rulebook.js` if the league's rules change.
- **Styling**: colors and layout live in `style.css`.

## Local preview

Because the page uses `fetch()` for `data/taxi-log.json`, opening
`index.html` directly from disk (`file://`) will fail that one request due
to browser CORS rules — the live Sleeper data will still load fine, though.
To preview everything locally, run a tiny local server from this folder,
e.g.:

```
python3 -m http.server 8000
```

then visit `http://localhost:8000`.
