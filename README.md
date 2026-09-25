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
- **Page-load speed**: transactions, player stats, and matchups are each
  fetched per-week from Sleeper, and by midseason that's dozens of live API
  calls on every single page load. A scheduled job
  (`.github/workflows/update-cache.yml`) runs `scripts/build-cache.mjs`
  every 15 minutes and commits `data/season-cache.json`, holding every
  already-completed week's data (a played week never changes, so it's safe
  to serve from a file that's a few minutes stale). The site fetches that
  one small same-origin file first, uses it for every week it covers, and
  only ever live-fetches the current, possibly in-progress week itself — so
  in-progress scores are never stale, but the site isn't re-fetching the
  whole season's history from Sleeper on every visit. If the cache file is
  missing, stale for the wrong season, or the job stops running, the site
  quietly falls back to fetching everything live like it always did — this
  is purely a speed optimization, nothing depends on it.
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
   General → allow workflows to run. Both scheduled workflows need "Read and
   write permissions" for `GITHUB_TOKEN` — check Settings → Actions →
   General → Workflow permissions, and set it to "Read and write
   permissions" so they can commit their files back to the repo.
6. Trigger the taxi tracker once by hand: Actions tab →
   "Track taxi squad moves" → Run workflow. Its first run just records a
   baseline snapshot (no events yet, since there's nothing to diff against);
   from the second run onward, any taxi moves since the last poll show up
   in the feed.
7. Trigger the season cache once by hand too: Actions tab → "Update season
   data cache" → Run workflow. This writes `data/season-cache.json`; after
   that it keeps itself updated every 15 minutes on its own.

## Pages

- **Home** — header stats (hard cap, a live countdown to the trade deadline
  computed from Sleeper's NFL season-start date, season phase), the
  Standings table (record, current streak, waiver priority, points for/
  against, and Max PF — the season total if each team had started its
  optimal lineup every week; seeds 1-2 marked 1st-round bye, 3-4 playoffs,
  5-6 wild card, and 7-10 show points back of 6th place; click a row to
  expand its Cap Health card), and the live activity feed with filters.
- **Cap Health** — the Salary Cap & Roster Hub: league-wide stat tiles,
  every team's cap breakdown ranked from most cap space to least, and a
  Cap Graveyard of tombstones for every dead-cap player.
- **League Rosters** — every team's active roster / taxi / IR with salaries,
  collapsed by default (ranked by remaining cap space).
- **Leaderboards** — Best Value Contracts, Highest Paid Players (with each
  player's season points and points-per-dollar alongside their salary), Dead
  Cap Wall, Biggest Busts (worst points-per-dollar, excluding players who
  simply haven't played — see note below), Best Waiver Pickups (cheapest
  winning FAAB bids still producing), Most Improved (points-per-game trend,
  first half of the season vs. recent weeks), and Most Active Traders (a
  lighter, non-judgmental stand-in for "Best Trades," which we skipped —
  grading who won a trade is a value call, not something a formula should
  decide). Note on Biggest Busts: Sleeper's stats API has no snap-count data
  at all, so games-actually-played (Sleeper's own per-week "gp" flag) is used
  instead to filter out injured/inactive players who scored 0 points because
  they never suited up — a player needs at least half of the season's weeks
  played so far (minimum 1) to qualify, so the list reflects underperformance
  rather than unavailability. Also includes a Contract Horizon table: every
  rostered player's projected 2027 salary if kept, using the sheet's
  already-computed keeper-escalator column, filterable by how big next
  year's raise is. This format has no fixed contract lengths (every player
  renews at the escalator rate or gets cut each offseason), so there's no
  real "expiring contract" subset — the filter is by raise size instead.
- **Trade Machine** — pick two teams, select players to send each way, set
  retained salary, see the resulting cap space.
- **Draft & FA** — a live 4-round/40-pick Draft Board for next season (picks
  1-4 set by Max PF ascending, picks 5-10 by current playoff seed worst-first,
  all 10 picks shown in one row per round), with traded picks resolved live
  and shown as "via &lt;original team&gt;" — click any pick to see how it was
  acquired (the trade it came from, everything else that changed hands in
  that trade, and the date), or "original pick, never traded" if it hasn't
  moved. The acquisition lookup searches the league's ENTIRE trade history —
  not just this season — by walking the same `previous_league_id` chain as
  Record Book/On This Day, so a pick traded two or three seasons ago still
  resolves correctly; that history is only fetched the first time you click
  a pick (and cached after that), so it doesn't slow down the page otherwise.
  If a trade also moved a pick from a season whose draft has already
  happened (e.g. a 2026 pick, dealt in an earlier trade), that line shows
  who the pick turned into instead of the owner's name ("2026 3rd-round
  pick — Player Name") by matching the pick's original draft slot against
  that season's actual Sleeper draft results. Plus the rookie salary
  schedule and free-agency/waiver rules.
- **Record Book** — a career leaderboard table (record, top-3-scoring
  seasons, playoff appearances, titles, championship-game appearances, #1
  seeds, trades, rookie-Draft-Pick Conversion Rate, and Lineup Efficiency —
  Points For ÷ Max PF, a career-wide measure of how rarely a manager leaves
  points on the bench), plus a card per current manager with a
  trophy-room key (championships 🏆, runner-ups 🥈, 3rd-place finishes 🥉,
  playoff appearances ⛳) — click a card to open a side drawer with that
  manager's all-time head-to-head record against every other manager.
  Labeled by each owner's Sleeper username rather than that season's team
  name, since franchise names get rebranded over the years but usernames
  don't. Built by walking the league's `previous_league_id` chain back to
  its very first season, so it covers the league's full history — this
  makes a lot of Sleeper API calls, so it's only loaded the first time you
  open the page, not on initial page load. Two notes on the trickier stats:
  Pick Conversion counts a rookie pick as "converted" if that GM never
  released the player within two seasons of drafting him (recent rookie
  picks aren't old enough to score yet, so they're excluded rather than
  counted against anyone); PF/Max PF is a career-wide aggregate, not an
  average of season percentages.
- **On This Day** — every trade, plus full results from any startup/rookie
  draft, that happened on today's calendar date in any past season. Walks
  the same full season history as Record Book, so it's lazy-loaded on
  first visit too.
- **Rule Book** — the full rulebook with a live search box.

## Global player search

Press **⌘K** / **Ctrl+K** (or **/** when focus isn't already in a text
field) anywhere on the site, or tap the "🔍 Search" button in the header, to
open a fuzzy player search (powered by [Fuse.js](https://www.fusejs.org/),
loaded from a CDN). It indexes every rostered player (with team, salary, and
next year's keeper price) plus every real skill-position NFL player who
isn't on a roster, shown as a free agent (this cap format has no pre-set
free-agent price, so those show without a salary rather than a fabricated
one). Selecting a rostered player's result jumps to their team's card on
League Rosters and expands it.

## Mobile layout

Below 768px, the Standings and Record Book tables switch from a wide grid to
stacked cards (each row's labels move inline via CSS container queries, so
this responds to the table's own container width, not just the viewport).
Every interactive control — nav buttons, the search bar and its results,
modal close buttons — keeps at least a 44×44px touch target.

## Adjusting things later

- **Poll frequency**: edit the `cron` line in
  `.github/workflows/track-taxi.yml`. GitHub's minimum practical interval is
  about 5 minutes, but every 1–3 hours is plenty for taxi moves.
- **Season cache frequency**: edit the `cron` line in
  `.github/workflows/update-cache.yml` (default every 15 minutes). It only
  ever rewrites already-completed weeks, so running it less often just means
  a slightly longer window where the latest completed week is still being
  fetched live instead of from cache — never stale or wrong data, just a bit
  slower to catch up. If your league goes fully dormant in the off-season,
  you can disable this workflow (Actions tab → "Update season data cache" →
  "···" → Disable workflow) to save Actions minutes; the site works fine
  without it either way.
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
