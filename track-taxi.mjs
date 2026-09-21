#!/usr/bin/env node
/**
 * Polls the Sleeper API for the current taxi-squad roster of every team in
 * the league, diffs it against the last snapshot committed to the repo, and
 * appends any taxi-add / taxi-remove events to data/taxi-log.json.
 *
 * Sleeper's public API has no history endpoint for taxi-squad moves (only a
 * live snapshot per roster), so this script is what turns that snapshot
 * into a real log over time. It's meant to be run on a schedule by
 * .github/workflows/track-taxi.yml.
 *
 * Requires Node 18+ (built-in fetch).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "roster-snapshot.json");
const LOG_PATH = path.join(DATA_DIR, "taxi-log.json");

// Read league_id out of config.js so there's exactly one place to configure it.
async function readLeagueId() {
  const configSrc = await readFile(path.join(REPO_ROOT, "config.js"), "utf8");
  const match = configSrc.match(/leagueId\s*:\s*["'`]([^"'`]+)["'`]/);
  if (!match) throw new Error("Could not find leagueId in config.js");
  return match[1];
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const leagueId = await readLeagueId();
  console.log(`Tracking taxi squads for league ${leagueId}`);

  const rosters = await fetchJSON(`https://api.sleeper.app/v1/league/${leagueId}/rosters`);

  const prevSnapshot = await readJsonSafe(SNAPSHOT_PATH, null);
  const prevTaxiByRoster = new Map(
    prevSnapshot ? Object.entries(prevSnapshot.taxiByRoster || {}) : []
  );

  const log = await readJsonSafe(LOG_PATH, []);
  const now = Date.now();
  const newEvents = [];

  const nextTaxiByRoster = {};
  for (const roster of rosters) {
    const rosterId = String(roster.roster_id);
    const currentTaxi = new Set((roster.taxi || []).map(String));
    nextTaxiByRoster[rosterId] = Array.from(currentTaxi);

    if (prevSnapshot === null) {
      // First run ever: establish a baseline, don't synthesize history.
      continue;
    }

    const prevTaxi = new Set(prevTaxiByRoster.get(rosterId) || []);

    for (const playerId of currentTaxi) {
      if (!prevTaxi.has(playerId)) {
        newEvents.push({
          id: `taxi-${rosterId}-${playerId}-${now}-add`,
          type: "taxi_add",
          date: now,
          roster_id: Number(rosterId),
          player_id: playerId,
        });
      }
    }
    for (const playerId of prevTaxi) {
      if (!currentTaxi.has(playerId)) {
        newEvents.push({
          id: `taxi-${rosterId}-${playerId}-${now}-remove`,
          type: "taxi_remove",
          date: now,
          roster_id: Number(rosterId),
          player_id: playerId,
        });
      }
    }
  }

  await mkdir(DATA_DIR, { recursive: true });

  if (newEvents.length) {
    const updatedLog = [...log, ...newEvents];
    await writeFile(LOG_PATH, JSON.stringify(updatedLog, null, 2) + "\n", "utf8");
    console.log(`Appended ${newEvents.length} taxi event(s).`);
  } else {
    console.log("No taxi squad changes detected.");
  }

  await writeFile(
    SNAPSHOT_PATH,
    JSON.stringify({ updated: now, taxiByRoster: nextTaxiByRoster }, null, 2) + "\n",
    "utf8"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
