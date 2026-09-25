#!/usr/bin/env node
/**
 * Pre-fetches every already-completed week's transactions, player stats, and
 * matchups from Sleeper into data/season-cache.json, so a normal page load
 * only needs one same-origin fetch of this file instead of ~3 live Sleeper
 * API calls per week of the season (which is most of why the site felt slow
 * to load, especially deep into a season).
 *
 * Only weeks *strictly before* the current week are cached — a played week's
 * results never change, so it's safe to serve to everyone from a file that's
 * up to 15 minutes stale. The current, possibly in-progress week is
 * deliberately left OUT of the cache: the site always fetches that one live
 * (see app.js), so nobody ever sees a stale in-progress score even if this
 * script's schedule is delayed or stops running entirely.
 *
 * Meant to run on a schedule via .github/workflows/update-cache.yml. If it
 * stops running, or data/season-cache.json goes missing, the site just falls
 * back to fetching everything live like it always used to — this is a speed
 * optimization, not a dependency.
 *
 * Requires Node 18+ (built-in fetch).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const CACHE_PATH = path.join(DATA_DIR, "season-cache.json");
const API = "https://api.sleeper.app/v1";

// Reads a single config.js value the same way track-taxi.mjs reads leagueId,
// so there's exactly one place (config.js) to configure the league.
async function readConfigValue(key) {
  const configSrc = await readFile(path.join(REPO_ROOT, "config.js"), "utf8");
  const match = configSrc.match(new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
  if (!match) throw new Error(`Could not find ${key} in config.js`);
  return match[1];
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const leagueId = await readConfigValue("leagueId");
  console.log(`Building season cache for league ${leagueId}`);

  const league = await fetchJSON(`${API}/league/${leagueId}`);
  const season = league.season;
  const currentWeek = Math.max(1, (league.settings && league.settings.leg) || 1);
  const weeksToCache = [];
  for (let w = 1; w < currentWeek; w++) weeksToCache.push(w);

  console.log(
    `Season ${season}, current week ${currentWeek} — caching weeks 1-${currentWeek - 1} ` +
      `(week ${currentWeek} onward is always fetched live by the site itself).`
  );

  const transactionsByWeek = {};
  const statsByWeek = {};
  const matchupsByWeek = {};

  const CONCURRENCY = 6;
  for (let i = 0; i < weeksToCache.length; i += CONCURRENCY) {
    const slice = weeksToCache.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (w) => {
        const [tx, stats, matchups] = await Promise.all([
          fetchJSON(`${API}/league/${leagueId}/transactions/${w}`).catch(() => []),
          fetchJSON(`${API}/stats/nfl/regular/${season}/${w}`).catch(() => ({})),
          fetchJSON(`${API}/league/${leagueId}/matchups/${w}`).catch(() => []),
        ]);

        transactionsByWeek[w] = (tx || []).filter((t) => t && t.status === "complete");

        // Sleeper's stats payload has 100+ fields per player; the site only
        // ever reads pts_half_ppr and gp, and this file gets fetched by
        // every visitor, so slim it down here rather than shipping the rest.
        const slimStats = {};
        for (const [playerId, s] of Object.entries(stats || {})) {
          if (!s || typeof s.pts_half_ppr !== "number") continue;
          slimStats[playerId] = { pts_half_ppr: s.pts_half_ppr, gp: s.gp };
        }
        statsByWeek[w] = slimStats;

        matchupsByWeek[w] = matchups || [];
      })
    );
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    CACHE_PATH,
    JSON.stringify({
      leagueId,
      season,
      currentWeek,
      generatedAt: Date.now(),
      transactionsByWeek,
      statsByWeek,
      matchupsByWeek,
    }) + "\n",
    "utf8"
  );
  console.log(`Wrote ${CACHE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
