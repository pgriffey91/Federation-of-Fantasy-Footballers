# League Activity Feed

A static site (no backend) that shows a live feed of your Sleeper dynasty
league's activity: adds (with FAAB $ amount), drops, trades, and taxi-squad
moves. Built to be hosted for free on GitHub Pages.

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

## One-time setup

1. **Create a GitHub repo** (public or private — Pages works with either on
   paid plans; public repos get Pages free) and push these files to it.
2. **Edit `config.js`** — set `leagueId` to your Sleeper league ID (already
   set to `1315034161047670784` for the Federation of Fantasy Football) and
   `siteName` to whatever you want the page titled.
3. **Enable GitHub Pages**: repo Settings → Pages → Source → "Deploy from a
   branch" → pick `main` and `/ (root)`. Save. Your site will be live at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.
4. **Enable Actions** (usually on by default): repo Settings → Actions →
   General → allow workflows to run. The taxi-tracker workflow needs
   "Read and write permissions" for `GITHUB_TOKEN` — check Settings →
   Actions → General → Workflow permissions, and set it to "Read and write
   permissions" so it can commit the log file back to the repo.
5. Optionally trigger the taxi tracker once by hand: Actions tab →
   "Track taxi squad moves" → Run workflow. Its first run just records a
   baseline snapshot (no events yet, since there's nothing to diff against);
   from the second run onward, any taxi moves since the last poll show up
   in the feed.

## Adjusting things later

- **Poll frequency**: edit the `cron` line in
  `.github/workflows/track-taxi.yml`. GitHub's minimum practical interval is
  about 5 minutes, but every 1–3 hours is plenty for taxi moves.
- **Season length**: `config.js`'s `maxWeek` controls how many weeks of
  transactions the site pulls (default 18, covering regular season +
  playoffs).
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
