/* League Activity Feed + Salary Cap Site
 * Combines live Sleeper API data (adds/drops/trades, rosters, users),
 * a GitHub-Action-maintained taxi-squad log, and the league's Google Sheet
 * salary ledger into one site: activity feed, cap health matrix, per-team
 * roster pages, value leaderboards, a trade calculator, and rule book.
 */

const CFG = window.LEAGUE_CONFIG;
const API = "https://api.sleeper.app/v1";
const PAGE_SIZE = 40;

const state = {
  league: null,
  rosterMap: new Map(), // roster_id -> { name, ownerDisplay, avatar, ownerId }
  players: new Map(), // player_id -> { name, pos, team }
  nameIndex: new Map(), // normalized player name -> player_id
  events: [],
  filtered: [],
  shown: 0,
  sheetByRoster: {}, // rosterId(string) -> { activeRoster, taxiSquad, ir, cap }
  pointsByPlayer: new Map(), // player_id -> total season points (approx half-PPR)
  weeklyPointsByPlayer: new Map(), // player_id -> Map(week -> points), for trend leaderboards
  trade: { teamA: null, teamB: null, retained: {} }, // retained: { "A:PlayerName": $, "B:PlayerName": $ }
  rosterPositions: [], // league's starting-lineup slot list (e.g. ["QB","RB","RB","WR","WR","TE","FLEX","DEF","K","BN",...])
  standingsExtra: { streakByRoster: new Map(), maxPFByRoster: new Map() },
  h2h: { loaded: false, loading: false, data: null }, // all-time head-to-head + trophy room (lazy-loaded)
  onThisDay: { loaded: false, loading: false, data: null }, // trades + drafts on this calendar day, any season (lazy-loaded)
  rawTransactions: [], // this season's deduped, complete transactions
};

const $ = (sel) => document.querySelector(sel);

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function setStatus(msg) {
  $("#status-line").textContent = msg;
}

function money(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n))}`;
}

/* ---------- Players database (cached in localStorage) ---------- */

async function loadPlayers() {
  const cacheKey = "sleeper_players_nfl_v1";
  const cacheTsKey = "sleeper_players_nfl_v1_ts";
  const maxAgeMs = (CFG.playerCacheHours || 24) * 3600 * 1000;

  try {
    const ts = Number(localStorage.getItem(cacheTsKey) || 0);
    if (ts && Date.now() - ts < maxAgeMs) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        applyPlayers(JSON.parse(cached));
        return;
      }
    }
  } catch (e) {
    // fall through to network
  }

  setStatus("Downloading player database from Sleeper (first load only, then cached)…");
  const data = await fetchJSON(`${API}/players/nfl`);
  applyPlayers(data);

  try {
    localStorage.setItem(cacheKey, JSON.stringify(data));
    localStorage.setItem(cacheTsKey, String(Date.now()));
  } catch (e) {
    // quota exceeded — skip caching
  }
}

function applyPlayers(data) {
  state.players.clear();
  state.nameIndex.clear();
  for (const [id, p] of Object.entries(data)) {
    if (!p) continue;
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || `Player ${id}`;
    const fantasyPositions = (p.fantasy_positions && p.fantasy_positions.length) ? p.fantasy_positions : (p.position ? [p.position] : []);
    state.players.set(id, { name, pos: p.position || "", team: p.team || "FA", fantasyPositions });
    const norm = SheetData.normalizeName(name);
    if (norm && !state.nameIndex.has(norm)) state.nameIndex.set(norm, id);
  }
}

function playerLabel(id) {
  const p = state.players.get(String(id));
  if (!p) return `Player #${id}`;
  return p.pos ? `${p.name} (${p.pos})` : p.name;
}

// Picks the rookie draft out of a season's Sleeper `drafts` list. Sleeper's
// `draft.type` is the draft FORMAT ("snake", "linear", "auction") — there is
// no "rookie" value — so a rookie draft can't be identified by type alone.
// This league's startup/auction draft runs through a Google Sheet rather
// than Sleeper (see README), so in practice every draft Sleeper knows about
// for this league already is a rookie draft; the "auction" exclusion here is
// just a safety net in case that ever changes. When more than one qualifies,
// the shortest one wins, since a rookie draft is a handful of rounds while a
// full-roster startup would be many more.
function pickRookieDraft(drafts) {
  const candidates = (drafts || []).filter((d) => d.type !== "auction");
  if (!candidates.length) return null;
  return candidates.reduce((best, d) => {
    const rounds = (d.settings && d.settings.rounds) || 999;
    const bestRounds = (best.settings && best.settings.rounds) || 999;
    return rounds < bestRounds ? d : best;
  }, candidates[0]);
}

function playerIdForName(name) {
  return state.nameIndex.get(SheetData.normalizeName(name));
}

/* ---------- League / rosters / users ---------- */

async function loadLeagueShell() {
  const [league, users, rosters, nflState] = await Promise.all([
    fetchJSON(`${API}/league/${CFG.leagueId}`),
    fetchJSON(`${API}/league/${CFG.leagueId}/users`),
    fetchJSON(`${API}/league/${CFG.leagueId}/rosters`),
    fetchJSON(`${API}/state/nfl`).catch((err) => {
      console.error("NFL state load failed (trade-deadline countdown disabled):", err);
      return null;
    }),
  ]);

  state.league = league;
  state.nflState = nflState;
  const userMap = new Map(users.map((u) => [u.user_id, u]));

  state.rosterMap.clear();
  for (const r of rosters) {
    const u = userMap.get(r.owner_id) || {};
    const teamName = (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${r.roster_id}`;
    const s = r.settings || {};
    state.rosterMap.set(r.roster_id, {
      name: teamName,
      ownerDisplay: u.display_name || teamName,
      avatar: u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null,
      ownerId: r.owner_id,
      taxiCount: (r.taxi || []).length,
      wins: s.wins || 0,
      losses: s.losses || 0,
      ties: s.ties || 0,
      pointsFor: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pointsAgainst: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      waiverPosition: s.waiver_position || null,
    });
  }

  state.rosterPositions = league.roster_positions || [];

  $("#site-title").textContent = CFG.siteName || league.name || "League Activity Feed";
  document.title = CFG.siteName || league.name || "League Activity Feed";

  populateTeamFilter();
  renderHeaderStats(league, nflState);
  return league;
}

function populateTeamFilter() {
  const teams = Array.from(state.rosterMap.entries())
    .map(([id, r]) => ({ id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const select of [$("#team-filter")]) {
    if (!select) continue;
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    for (const t of teams) {
      const key = String(t.id);
      if (existing.has(key)) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = t.name;
      select.appendChild(opt);
    }
  }
}

function teamName(rosterId) {
  const r = state.rosterMap.get(rosterId) || state.rosterMap.get(Number(rosterId));
  return r ? r.name : `Roster ${rosterId}`;
}

/* ---------- Header stats ---------- */

let deadlineTimer = null;

function renderHeaderStats(league, nflState) {
  $("#stat-cap").textContent = `$${CFG.hardCap}`;

  const deadlineWeek = league.settings && league.settings.trade_deadline;
  const deadlineEl = $("#stat-deadline");

  if (deadlineTimer) {
    clearInterval(deadlineTimer);
    deadlineTimer = null;
  }

  // Sleeper's weeks reset every 7 days from the NFL season's start date, so
  // the trade-deadline week's start date is season_start_date + (week-1)*7d.
  if (deadlineEl && deadlineWeek && nflState && nflState.season_start_date && league.status !== "complete") {
    const seasonStart = new Date(`${nflState.season_start_date}T00:00:00Z`);
    const deadlineDate = new Date(seasonStart.getTime() + (deadlineWeek - 1) * 7 * 24 * 3600 * 1000);

    const tick = () => {
      const diffMs = deadlineDate.getTime() - Date.now();
      deadlineEl.title = `Trade deadline: Week ${deadlineWeek} (${deadlineDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
      if (diffMs <= 0) {
        deadlineEl.textContent = `Week ${deadlineWeek} — Passed`;
        deadlineEl.classList.add("deadline-passed");
        clearInterval(deadlineTimer);
        deadlineTimer = null;
        return;
      }
      deadlineEl.classList.remove("deadline-passed");
      const days = Math.floor(diffMs / (24 * 3600 * 1000));
      const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
      const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
      deadlineEl.textContent = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
    };

    tick();
    deadlineTimer = setInterval(tick, 60 * 1000);
  } else if (deadlineEl) {
    deadlineEl.textContent = deadlineWeek ? `Week ${deadlineWeek}` : "—";
    deadlineEl.title = "";
  }

  const leg = (league.settings && league.settings.leg) || 1;
  const playoffStart = (league.settings && league.settings.playoff_week_start) || 15;
  let phase = "—";
  if (league.status === "complete") phase = "Season Complete";
  else if (league.status === "pre_draft" || league.status === "drafting") phase = "Off-Season — Draft";
  else if (league.status === "in_season") {
    phase = leg >= playoffStart ? `Playoffs — Week ${leg}` : `In-Season — Week ${leg}`;
  } else {
    phase = "Off-Season";
  }
  $("#stat-phase").textContent = phase;
}

let lastSyncedAt = null;
function markSynced() {
  lastSyncedAt = Date.now();
  updateSyncBadge();
}
function updateSyncBadge() {
  const el = $("#sync-text");
  if (!el) return;
  if (!lastSyncedAt) {
    el.textContent = "Loading…";
    return;
  }
  const secs = Math.round((Date.now() - lastSyncedAt) / 1000);
  if (secs < 5) el.textContent = "Sleeper synced just now";
  else if (secs < 60) el.textContent = `Sleeper synced ${secs}s ago`;
  else el.textContent = `Sleeper synced ${Math.round(secs / 60)}m ago`;
}
setInterval(updateSyncBadge, 15000);

/* ---------- Cap Health Matrix ---------- */

// Builds a single team's cap-health card as an HTML string. Shared by the
// full matrix (Cap Health page) and the expandable Standings rows on Home.
function buildCapCardHTML(rid) {
  const cap = state.sheetByRoster[rid] && state.sheetByRoster[rid].cap;
  if (!cap) {
    return '<div class="empty-state">Salary data not available — check the Google Sheet is shared as "Anyone with the link".</div>';
  }

  const taxiSlots = (state.league && state.league.settings && state.league.settings.taxi_slots) || 5;
  const usedActive = cap.activeSalary + cap.irSalary;
  const pct = (n) => Math.max(0, Math.min(100, (n / CFG.hardCap) * 100));
  const over = cap.remainingCap < 0;
  const r = state.rosterMap.get(Number(rid));
  const taxiCount = r ? r.taxiCount : 0;
  const failed = state.sheetByRoster[rid] && state.sheetByRoster[rid].loadFailed;

  return `
    <div class="cap-card">
      <div class="cap-card-head">
        <span class="cap-team-name">${teamName(Number(rid))}</span>
        <span class="cap-badges">
          ${failed ? '<span class="badge over-cap-badge">⚠ Roster data failed to load</span>' : ""}
          <span class="badge taxi-badge">${taxiCount}/${taxiSlots} Taxi</span>
          ${over
            ? '<span class="badge over-cap-badge">⚠ OVER CAP</span>'
            : '<span class="badge compliant-badge">✓ Compliant</span>'}
        </span>
      </div>
      <div class="cap-bar">
        <div class="cap-seg cap-seg-active" style="width:${pct(usedActive)}%" title="Active roster salary: ${money(usedActive)}"></div>
        <div class="cap-seg cap-seg-dead" style="width:${pct(cap.deadCap)}%" title="Dead cap: ${money(cap.deadCap)}"></div>
        <div class="cap-seg cap-seg-remaining" style="width:${pct(cap.remainingCap)}%" title="Remaining: ${money(cap.remainingCap)}"></div>
      </div>
      <div class="cap-legend">
        <span><i class="dot dot-active"></i>Active ${money(usedActive)}${failed ? " (unavailable)" : ""}</span>
        <span><i class="dot dot-dead"></i>Dead ${money(cap.deadCap)}</span>
        <span><i class="dot dot-remaining"></i>Open ${money(cap.remainingCap)}</span>
      </div>
    </div>
  `;
}

function renderCapMatrix() {
  const container = $("#cap-matrix");
  container.innerHTML = "";

  const rosterIds = Object.keys(CFG.sheetTabsByRosterId);
  const cards = rosterIds
    .map((rid) => ({ rid, cap: state.sheetByRoster[rid] && state.sheetByRoster[rid].cap }))
    .filter((x) => x.cap)
    // Most cap space first, least cap space (or over cap) at the bottom.
    .sort((a, b) => b.cap.remainingCap - a.cap.remainingCap);

  if (!cards.length) {
    container.innerHTML = '<div class="empty-state">Salary data not available — check the Google Sheet is shared as "Anyone with the link".</div>';
    return;
  }

  const taxiSlots = (state.league && state.league.settings && state.league.settings.taxi_slots) || 5;
  const numTeams = cards.length;

  let totalDead = 0;
  let totalOpen = 0;
  let taxiUsedTotal = 0;
  for (const { rid, cap } of cards) {
    totalDead += cap.deadCap;
    totalOpen += cap.remainingCap;
    const r = state.rosterMap.get(Number(rid));
    taxiUsedTotal += r ? r.taxiCount : 0;
  }
  const avgOpen = totalOpen / numTeams;
  const avgUsed = CFG.hardCap - avgOpen;
  const taxiSlotsTotal = taxiSlots * numTeams;
  const taxiPct = taxiSlotsTotal ? Math.round((taxiUsedTotal / taxiSlotsTotal) * 100) : 0;

  const statsHTML = `
    <div class="cap-hub-stats">
      <div class="cap-hub-stat">
        <div class="cap-hub-stat-label">Hard Cap</div>
        <div class="cap-hub-stat-value">${money(CFG.hardCap)}</div>
        <div class="cap-hub-stat-sub">Per Team</div>
      </div>
      <div class="cap-hub-stat">
        <div class="cap-hub-stat-label">League Avg Cap</div>
        <div class="cap-hub-stat-value">${money(avgUsed)}</div>
        <div class="cap-hub-stat-sub accent">${money(avgOpen)} Avg Open</div>
      </div>
      <div class="cap-hub-stat">
        <div class="cap-hub-stat-label">Total Dead Cap</div>
        <div class="cap-hub-stat-value">${money(totalDead)}</div>
        <div class="cap-hub-stat-sub">Across ${numTeams} Teams</div>
      </div>
      <div class="cap-hub-stat">
        <div class="cap-hub-stat-label">Taxi Spots</div>
        <div class="cap-hub-stat-value">${taxiUsedTotal} / ${taxiSlotsTotal}</div>
        <div class="cap-hub-stat-sub accent">${taxiPct}% Filled</div>
      </div>
    </div>
  `;

  const rowsHTML = cards
    .map(({ rid, cap }, idx) => {
      const r = state.rosterMap.get(Number(rid)) || {};
      const usedActive = cap.activeSalary + cap.irSalary;
      const pct = (n) => Math.max(0, Math.min(100, (n / CFG.hardCap) * 100));
      const over = cap.remainingCap < 0;
      const taxiCount = r.taxiCount || 0;
      const failed = state.sheetByRoster[rid] && state.sheetByRoster[rid].loadFailed;
      const usedPct = Math.round(((usedActive + cap.deadCap) / CFG.hardCap) * 100);
      const record = r.wins != null ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}` : "";
      const pf = r.pointsFor != null ? `${r.pointsFor.toFixed(1)} PF` : "";

      return `
        <div class="cap-hub-row">
          <div class="cap-hub-row-top">
            <span class="cap-hub-rank">${idx + 1}</span>
            <span class="cap-hub-team-block">
              <span class="cap-hub-team-name">${teamName(Number(rid))}</span>
              <span class="cap-hub-owner">${r.ownerDisplay || ""}</span>
            </span>
            <span class="cap-hub-record">${[record, pf].filter(Boolean).join(" | ")}</span>
            <span class="cap-hub-badges">
              ${failed ? '<span class="badge over-cap-badge">⚠ Data failed</span>' : ""}
              <span class="badge taxi-badge">${taxiCount}/${taxiSlots} Taxi</span>
              ${over
                ? '<span class="badge over-cap-badge">⚠ OVER CAP</span>'
                : '<span class="badge compliant-badge">✓ Compliant</span>'}
            </span>
          </div>
          <div class="cap-bar">
            <div class="cap-seg cap-seg-active" style="width:${pct(usedActive)}%" title="Active: ${money(usedActive)}"></div>
            <div class="cap-seg cap-seg-dead" style="width:${pct(cap.deadCap)}%" title="Dead: ${money(cap.deadCap)}"></div>
            <div class="cap-seg cap-seg-remaining" style="width:${pct(cap.remainingCap)}%" title="Open: ${money(cap.remainingCap)}"></div>
          </div>
          <div class="cap-hub-row-bottom">
            <span class="cap-hub-legend"><i class="dot dot-active"></i>Active ${money(usedActive)}</span>
            <span class="cap-hub-legend"><i class="dot dot-dead"></i>Dead ${money(cap.deadCap)}</span>
            <span class="cap-hub-legend ${over ? "over-cap-text" : ""}"><i class="dot dot-remaining"></i>Open ${money(cap.remainingCap)}</span>
            <span class="cap-hub-used-pct">${usedPct}% Used</span>
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="cap-hub-card">
      <div class="cap-hub-eyebrow">${CFG.siteName || "League"}</div>
      <h2 class="cap-hub-title">Salary Cap &amp; Roster Hub</h2>
      ${statsHTML}
      <h3 class="cap-hub-subhead">Franchise Cap Breakdowns</h3>
      <div class="cap-hub-list">${rowsHTML}</div>
    </div>
    ${buildGraveyardHTML(cards, totalDead)}
  `;
}

const EPITAPHS = [
  "Cut down before their prime.",
  "Gone, but the bill remains.",
  "A contract that wouldn't die.",
  "Waived. Not forgotten. Still billed.",
  "Rest in cap space.",
  "Here lies value, long since departed.",
  "Dropped, but never truly gone.",
  "Paid in full. Played in none.",
  "May its cap hit rest in peace.",
  "Benched by the Grim Waiver.",
];

// A tombstone per dropped player still costing someone cap space — the
// morbidly fun face on what's otherwise just a "dead cap" number.
function buildGraveyardHTML(cards, totalDead) {
  const plots = [];
  for (const { rid } of cards) {
    const entry = state.sheetByRoster[rid];
    if (!entry || !entry.deadCapPlayers) continue;
    for (const p of entry.deadCapPlayers) {
      if (p.salary > 0) plots.push({ name: p.name, salary: p.salary, rid });
    }
  }
  if (!plots.length) return "";

  plots.sort((a, b) => b.salary - a.salary);

  const stonesHTML = plots
    .map((p, i) => {
      const epitaph = EPITAPHS[i % EPITAPHS.length];
      return `
        <div class="tombstone">
          <div class="tombstone-skull">💀</div>
          <div class="tombstone-rip">R.I.P.</div>
          <div class="tombstone-name">${p.name}</div>
          <div class="tombstone-salary">${money(p.salary)}</div>
          <div class="tombstone-team">Buried by ${teamName(Number(p.rid))}</div>
          <div class="tombstone-epitaph">"${epitaph}"</div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="cap-hub-card graveyard-card">
      <h2 class="cap-hub-title">⚰️ Cap Graveyard</h2>
      <p class="cap-hub-subhead graveyard-sub">${money(totalDead)} in salary buried across the league — ${plots.length} fallen contract${plots.length === 1 ? "" : "s"}</p>
      <div class="graveyard-grid">${stonesHTML}</div>
    </div>
  `;
}

/* ---------- Standings: weekly matchups (streak + Max PF) ---------- */

// Which real positions can fill a given roster slot. Anything not covered
// here (QB, RB, WR, TE, K, DEF, single IDP slots, ...) requires an exact
// fantasy_positions match with the slot name itself.
function eligiblePositionsForSlot(slot) {
  switch (slot) {
    case "FLEX": return ["RB", "WR", "TE"];
    case "SUPER_FLEX": return ["QB", "RB", "WR", "TE"];
    case "WRRB_FLEX": return ["WR", "RB"];
    case "REC_FLEX":
    case "WRTE_FLEX": return ["WR", "TE"];
    case "RB_FLEX": return ["RB", "WR"];
    case "IDP_FLEX": return ["DL", "LB", "DB"];
    default: return [slot];
  }
}

const NON_STARTING_SLOTS = new Set(["BN", "IR", "TAXI"]);

// Greedy best-lineup solver: fills the most position-restrictive slots
// first (so a naturally-scarce single-position slot doesn't get starved by
// a wide-open FLEX/SUPER_FLEX grabbing the best player first), each time
// taking the highest-scoring still-eligible, still-unassigned player.
function computeOptimalLineupPoints(playerIds, playersPoints, rosterPositions) {
  const startSlots = (rosterPositions || []).filter((p) => !NON_STARTING_SLOTS.has(p));
  if (!startSlots.length || !playerIds || !playerIds.length) return 0;

  const slotsSorted = startSlots
    .map((slot, i) => ({ slot, i, elig: eligiblePositionsForSlot(slot) }))
    .sort((a, b) => a.elig.length - b.elig.length || a.i - b.i);

  const available = new Set(playerIds);
  let total = 0;

  for (const { elig } of slotsSorted) {
    let bestId = null;
    let bestPts = -Infinity;
    for (const pid of available) {
      const p = state.players.get(String(pid));
      const positions = p && p.fantasyPositions && p.fantasyPositions.length ? p.fantasyPositions : p ? [p.pos] : [];
      if (!positions.some((pos) => elig.includes(pos))) continue;
      const pts = playersPoints[pid] != null ? playersPoints[pid] : 0;
      if (pts > bestPts) {
        bestPts = pts;
        bestId = pid;
      }
    }
    if (bestId != null) {
      available.delete(bestId);
      total += bestPts;
    }
  }
  return total;
}

// Pulls every played week's matchups to derive each team's current win/loss
// streak and season-long "Max PF" (the points they'd have if their optimal
// lineup — best scorer at every slot, bench included — had started every
// week). Skips weeks that haven't been played yet (all-zero points).
async function loadStandingsExtras(currentWeek) {
  const weeks = [];
  for (let w = 1; w <= currentWeek; w++) weeks.push(w);

  const results = await Promise.allSettled(
    weeks.map((w) => fetchJSON(`${API}/league/${CFG.leagueId}/matchups/${w}`).then((data) => ({ week: w, data })))
  );

  const weeklyByRoster = new Map(); // roster_id -> [{ week, result }]
  const maxPFByRoster = new Map(); // roster_id -> total optimal points

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { week, data } = r.value;
    if (!Array.isArray(data) || !data.length) continue;
    const totalPoints = data.reduce((s, e) => s + (e.points || 0), 0);
    if (totalPoints <= 0) continue; // week hasn't been played yet

    const byMatchup = new Map();
    for (const e of data) {
      if (!byMatchup.has(e.matchup_id)) byMatchup.set(e.matchup_id, []);
      byMatchup.get(e.matchup_id).push(e);
    }

    for (const e of data) {
      const rid = e.roster_id;
      const maxPts = computeOptimalLineupPoints(e.players || [], e.players_points || {}, state.rosterPositions);
      maxPFByRoster.set(rid, (maxPFByRoster.get(rid) || 0) + maxPts);

      const group = byMatchup.get(e.matchup_id) || [];
      let result = null;
      if (group.length === 2) {
        const [a, b] = group;
        if (a.points === b.points) result = "T";
        else result = (a.points > b.points ? a.roster_id : b.roster_id) === rid ? "W" : "L";
      }
      if (result) {
        if (!weeklyByRoster.has(rid)) weeklyByRoster.set(rid, []);
        weeklyByRoster.get(rid).push({ week, result });
      }
    }
  }

  const streakByRoster = new Map();
  for (const [rid, weeksArr] of weeklyByRoster.entries()) {
    weeksArr.sort((a, b) => a.week - b.week);
    let streak = 0;
    let type = null;
    for (let i = weeksArr.length - 1; i >= 0; i--) {
      if (type === null) {
        type = weeksArr[i].result;
        streak = 1;
      } else if (weeksArr[i].result === type) {
        streak++;
      } else {
        break;
      }
    }
    streakByRoster.set(rid, type ? `${type}${streak}` : "—");
  }

  return { streakByRoster, maxPFByRoster };
}

/* ---------- Standings ---------- */

// Seeds 1-4 are set by record (1 = 1st-round bye, 2 = 2nd-round bye, 3-4 =
// playoffs). Seeds 5-6 are set by points scored among the remaining teams
// (wild card). Seeds 7-10 miss the playoffs (headed for the following
// year's draft lottery) and show how many points they're back of 6th place
// instead of a plain label.
function rankMeta(seed, ranked) {
  if (seed === 1) return { label: "1st Bye", cls: "rk-bye" };
  if (seed === 2) return { label: "2nd Bye", cls: "rk-bye" };
  if (seed <= 4) return { label: "Playoffs", cls: "rk-playoff" };
  if (seed <= 6) return { label: "Points WC", cls: "rk-wildcard" };
  const sixth = ranked[5];
  const gap = sixth ? Math.max(0, sixth.pointsFor - ranked[seed - 1].pointsFor) : 0;
  return { label: `${gap.toFixed(2)} back`, cls: "rk-out" };
}

function streakClass(streak) {
  if (streak.startsWith("W")) return "streak-win";
  if (streak.startsWith("L")) return "streak-loss";
  if (streak.startsWith("T")) return "streak-tie";
  return "";
}

// Shared seeding logic: seeds 1-4 by record (wins desc, losses asc, points
// scored as tiebreak); seeds 5-10 by points scored regardless of record, per
// league convention. Returns an array of 10 team objects (rid + roster info)
// in seed order (index 0 = seed 1). Used by both Standings and the Draft
// Board (picks 5-10 mirror seeds 1-6, picks 1-4 come from seeds 7-10).
// Generic version of the seeding convention: takes any array of
// { rid, wins, losses, pointsFor, ... } and returns it re-ordered into seeds
// 1-10. Used for the live Standings page and, per-season, by the
// Head-to-Head leaderboard (to find each season's #1 seed and top scorers).
function seedTeams(teams) {
  const byRecord = [...teams].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return b.pointsFor - a.pointsFor;
  });
  const top4 = byRecord.slice(0, 4);
  const top4Ids = new Set(top4.map((t) => t.rid));
  const rest = teams.filter((t) => !top4Ids.has(t.rid)).sort((a, b) => b.pointsFor - a.pointsFor);
  return [...top4, ...rest];
}

function getStandingsRanked() {
  const rosterIds = Array.from(state.rosterMap.keys());
  if (!rosterIds.length) return [];
  const teams = rosterIds.map((rid) => ({ rid, ...state.rosterMap.get(rid) }));
  return seedTeams(teams);
}

function renderStandings() {
  const container = $("#standings");
  if (!container) return;

  const ranked = getStandingsRanked();
  if (!ranked.length) {
    container.innerHTML = '<div class="empty-state">Standings not available.</div>';
    return;
  }

  const extra = state.standingsExtra;
  const week = (state.league && state.league.settings && state.league.settings.leg) || 1;

  const rows = ranked
    .map((t, idx) => {
      const seed = idx + 1;
      const meta = rankMeta(seed, ranked);
      const record = `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`;
      const streak = extra.streakByRoster.get(t.rid) || "—";
      const waiver = t.waiverPosition ? `#${t.waiverPosition}` : "—";
      const maxPF = extra.maxPFByRoster.get(t.rid) || 0;
      const ridStr = String(t.rid);

      const cap = state.sheetByRoster[ridStr] && state.sheetByRoster[ridStr].cap;
      const capBar = cap
        ? (() => {
            const usedActive = cap.activeSalary + cap.irSalary;
            const pct = (n) => Math.max(0, Math.min(100, (n / CFG.hardCap) * 100));
            const over = cap.remainingCap < 0;
            return `
              <div class="cap-mini-bar" title="Active ${money(usedActive)} · Dead ${money(cap.deadCap)} · Open ${money(cap.remainingCap)}">
                <div class="cap-mini-seg cap-seg-active" style="width:${pct(usedActive)}%"></div>
                <div class="cap-mini-seg cap-seg-dead" style="width:${pct(cap.deadCap)}%"></div>
                <div class="cap-mini-seg cap-seg-remaining" style="width:${pct(cap.remainingCap)}%"></div>
              </div>
              <span class="cap-avail ${over ? "over-cap-text" : ""}">${money(cap.remainingCap)}</span>
            `;
          })()
        : '<span class="muted-note">—</span>';

      return `
        <tr class="standings-row" data-rid="${ridStr}">
          <td><span class="standings-rank-sq ${meta.cls}">${seed}</span></td>
          <td class="standings-team-cell">
            ${t.avatar ? `<img class="standings-avatar" src="${t.avatar}" alt="">` : '<span class="standings-avatar standings-avatar-blank"></span>'}
            <span class="standings-team-block">
              <span class="standings-team-line">
                <span class="standings-team-name">${t.name}</span>
                <span class="standings-badge-pill ${meta.cls}">${meta.label}</span>
              </span>
              <span class="standings-owner">${t.ownerDisplay}</span>
            </span>
          </td>
          <td>${record}</td>
          <td class="${streakClass(streak)}">${streak}</td>
          <td>${waiver}</td>
          <td class="num">${t.pointsFor.toFixed(2)}</td>
          <td class="num">${t.pointsAgainst.toFixed(2)}</td>
          <td class="num">${maxPF.toFixed(2)}</td>
          <td class="standings-cap-cell">${capBar}</td>
          <td class="standings-caret-cell"><span class="standings-caret">▾</span></td>
        </tr>
        <tr class="standings-detail-row" data-detail-for="${ridStr}" hidden>
          <td colspan="10"><div class="standings-detail-inner"></div></td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="standings-card">
      <div class="standings-card-head">
        <div>
          <div class="standings-title-row">
            <h2 class="standings-title">League Standings</h2>
            <span class="week-pill">Week ${week}</span>
          </div>
          <p class="standings-subtitle">${CFG.siteName || "League"} • ${ranked.length} Teams • Hard Cap $${CFG.hardCap}</p>
          <p class="standings-seed-key">Seeds 1–4 by record · 5–6 by points scored · 7–10 draft lottery</p>
        </div>
        <div class="cap-legend-inline">
          <span><i class="dot dot-active"></i>Active Cap</span>
          <span><i class="dot dot-dead"></i>Dead Cap</span>
          <span><i class="dot dot-remaining"></i>Space</span>
        </div>
      </div>
      <div class="standings-table-wrap">
        <table class="standings-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Franchise</th>
              <th>W-L</th>
              <th>Streak</th>
              <th>Waiver Pri.</th>
              <th class="num">Points For</th>
              <th class="num">Points Against</th>
              <th class="num">Max PF</th>
              <th>Cap Breakdown ($${CFG.hardCap})</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  container.querySelectorAll(".standings-row").forEach((row) => {
    row.addEventListener("click", () => {
      const rid = row.dataset.rid;
      const detailRow = container.querySelector(`.standings-detail-row[data-detail-for="${rid}"]`);
      const inner = detailRow.querySelector(".standings-detail-inner");
      const expanded = row.classList.contains("expanded");
      if (expanded) {
        row.classList.remove("expanded");
        detailRow.hidden = true;
        return;
      }
      if (!inner.dataset.filled) {
        inner.innerHTML = buildCapCardHTML(rid);
        inner.dataset.filled = "1";
      }
      row.classList.add("expanded");
      detailRow.hidden = false;
    });
  });
}

/* ---------- Transactions (live from Sleeper) ---------- */

async function loadTransactions(maxWeek) {
  const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
  const chunks = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < weeks.length; i += CONCURRENCY) {
    const slice = weeks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map((w) =>
        fetchJSON(`${API}/league/${CFG.leagueId}/transactions/${w}`).catch(() => [])
      )
    );
    chunks.push(...results);
  }
  const all = chunks.flat();
  const seen = new Set();
  const deduped = [];
  for (const tx of all) {
    if (!tx || seen.has(tx.transaction_id)) continue;
    seen.add(tx.transaction_id);
    deduped.push(tx);
  }
  return deduped.filter((tx) => tx.status === "complete");
}

function findSheetSalaryForDrop(playerName, rosterId) {
  // The dropping team's own "Dropped Players" dead-cap table is the
  // authoritative source for what a dropped player's salary was. Fall back
  // to that player still showing up on someone's active roster (e.g. the
  // sheet hasn't been updated yet) as a secondary guess.
  const norm = SheetData.normalizeName(playerName);
  const own = state.sheetByRoster[rosterId];
  if (own) {
    const hit = own.deadCapPlayers.find((p) => SheetData.normalizeName(p.name) === norm);
    if (hit) return hit.salary;
  }
  for (const rid of Object.keys(state.sheetByRoster)) {
    const sheet = state.sheetByRoster[rid];
    for (const p of sheet.activeRoster) {
      if (SheetData.normalizeName(p.name) === norm) return p.salary;
    }
  }
  return null;
}

function transactionsToEvents(transactions) {
  const events = [];

  for (const tx of transactions) {
    const created = tx.status_updated || tx.created;

    if (tx.type === "trade") {
      events.push(...tradeToEvents(tx, created));
      continue;
    }

    const bid = tx.settings && typeof tx.settings.waiver_bid === "number" ? tx.settings.waiver_bid : null;

    if (tx.adds) {
      for (const [playerId, rosterId] of Object.entries(tx.adds)) {
        events.push({
          id: `${tx.transaction_id}-add-${playerId}`,
          type: "add",
          date: created,
          rosterIds: [rosterId],
          playerIds: [playerId],
          amount: bid,
        });
      }
    }
    if (tx.drops) {
      for (const [playerId, rosterId] of Object.entries(tx.drops)) {
        events.push({
          id: `${tx.transaction_id}-drop-${playerId}`,
          type: "drop",
          date: created,
          rosterIds: [rosterId],
          playerIds: [playerId],
          amount: null,
        });
      }
    }
  }

  return events;
}

function tradeToEvents(tx, created) {
  const adds = tx.adds || {};
  const picks = tx.draft_picks || [];
  const budgetMoves = tx.waiver_budget || [];
  const rosterIds = tx.roster_ids || [];

  const gains = new Map();
  for (const id of rosterIds) gains.set(id, { players: [], picks: [], cap: 0 });

  for (const [playerId, rosterId] of Object.entries(adds)) {
    if (!gains.has(rosterId)) gains.set(rosterId, { players: [], picks: [], cap: 0 });
    gains.get(rosterId).players.push(playerId);
  }
  for (const pick of picks) {
    const toRoster = pick.owner_id;
    if (!gains.has(toRoster)) gains.set(toRoster, { players: [], picks: [], cap: 0 });
    gains.get(toRoster).picks.push(pick);
  }
  for (const move of budgetMoves) {
    if (!gains.has(move.receiver)) gains.set(move.receiver, { players: [], picks: [], cap: 0 });
    gains.get(move.receiver).cap += move.amount;
  }

  return [
    {
      id: `${tx.transaction_id}-trade`,
      type: "trade",
      date: created,
      rosterIds,
      gains: Array.from(gains.entries()),
    },
  ];
}

function pickLabel(pick) {
  const round = pick.round;
  const suffix = round === 1 ? "st" : round === 2 ? "nd" : round === 3 ? "rd" : "th";
  const originalTeam = teamName(pick.roster_id);
  return `${pick.season} ${round}${suffix}-round pick (${originalTeam}'s)`;
}

/* ---------- Taxi log ---------- */

async function loadTaxiLog() {
  try {
    const log = await fetchJSON(`data/taxi-log.json?_=${Date.now()}`);
    return (Array.isArray(log) ? log : []).map((e) => ({
      id: e.id,
      type: e.type,
      date: e.date,
      rosterIds: [e.roster_id],
      playerIds: [e.player_id],
      amount: null,
    }));
  } catch (e) {
    console.warn("No taxi log available yet:", e);
    return [];
  }
}

/* ---------- Feed rendering ---------- */

function formatDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function eventMatchesFilters(ev, { teamId, types, query }) {
  if (types.size && !types.has(ev.type)) return false;
  if (teamId && !ev.rosterIds.map(String).includes(teamId)) return false;
  if (query) {
    const q = query.toLowerCase();
    if (ev.type === "trade") {
      const gainNames = ev.gains.flatMap(([, g]) => g.players.map((p) => playerLabel(p).toLowerCase()));
      if (!gainNames.some((n) => n.includes(q))) return false;
    } else {
      const names = (ev.playerIds || []).map((id) => playerLabel(id).toLowerCase());
      if (!names.some((n) => n.includes(q))) return false;
    }
  }
  return true;
}

function renderEventCard(ev) {
  const card = document.createElement("article");
  card.className = "event-card";

  const badge = document.createElement("div");
  badge.className = `event-badge ${ev.type}`;
  card.appendChild(badge);

  const body = document.createElement("div");
  body.className = "event-body";
  const title = document.createElement("p");
  title.className = "event-title";

  if (ev.type === "trade") {
    const teams = ev.rosterIds.map((id) => teamName(id));
    const parts = ev.gains
      .filter(([, g]) => g.players.length || g.picks.length || g.cap)
      .map(([rosterId, g]) => {
        const items = [
          ...g.players.map((p) => playerLabel(p)),
          ...g.picks.map((p) => pickLabel(p)),
        ];
        if (g.cap) items.push(`<span class="amount">+${money(g.cap)}</span> cap space`);
        return `<span class="team">${teamName(rosterId)}</span> gets ${items.join(", ")}`;
      });
    title.innerHTML = `<span class="tag trade">Trade</span> ${teams.join(" ⇄ ")}<br>` + parts.join("<br>");
  } else if (ev.type === "add") {
    const amountHtml = ev.amount !== null ? ` for <span class="amount">$${ev.amount}</span> FAAB` : "";
    title.innerHTML = `<span class="tag add">Add</span> <span class="team">${teamName(ev.rosterIds[0])}</span> added ${playerLabel(ev.playerIds[0])}${amountHtml}`;
  } else if (ev.type === "drop") {
    const p = state.players.get(String(ev.playerIds[0]));
    const salary = p ? findSheetSalaryForDrop(p.name, ev.rosterIds[0]) : null;
    const salaryHtml = salary !== null ? ` <span class="salary-tag">Salary: ${money(salary)}</span>` : "";
    title.innerHTML = `<span class="tag drop">Drop</span> <span class="team">${teamName(ev.rosterIds[0])}</span> dropped ${playerLabel(ev.playerIds[0])}${salaryHtml}`;
  } else if (ev.type === "taxi_add") {
    title.innerHTML = `<span class="tag taxi_add">Taxi</span> <span class="team">${teamName(ev.rosterIds[0])}</span> moved ${playerLabel(ev.playerIds[0])} onto the taxi squad`;
  } else if (ev.type === "taxi_remove") {
    title.innerHTML = `<span class="tag taxi_remove">Taxi</span> <span class="team">${teamName(ev.rosterIds[0])}</span> moved ${playerLabel(ev.playerIds[0])} off the taxi squad`;
  }

  const meta = document.createElement("p");
  meta.className = "event-meta";
  meta.textContent = formatDate(ev.date);

  body.appendChild(title);
  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

function currentFilters() {
  const teamId = $("#team-filter").value;
  const types = new Set(Array.from(document.querySelectorAll(".checkboxes input:checked")).map((c) => c.value));
  const query = $("#search-box").value.trim();
  return { teamId, types, query };
}

function applyFilters() {
  const filters = currentFilters();
  state.filtered = state.events.filter((ev) => eventMatchesFilters(ev, filters));
  state.shown = 0;
  $("#feed").innerHTML = "";
  renderMore();
}

function renderMore() {
  const feed = $("#feed");
  const slice = state.filtered.slice(state.shown, state.shown + PAGE_SIZE);
  for (const ev of slice) feed.appendChild(renderEventCard(ev));
  state.shown += slice.length;
  if (state.filtered.length === 0) {
    feed.innerHTML = '<div class="empty-state">No activity matches these filters.</div>';
  }
  $("#load-more-wrap").hidden = state.shown >= state.filtered.length;
}

/* ---------- League Rosters ---------- */

function rosterTableHTML(sheet) {
  const section = (title, rows, cssClass) => {
    if (!rows.length) return `<h4>${title}</h4><p class="muted-note">None</p>`;
    const body = rows
      .map((p) => `<tr><td>${p.name}</td><td>${p.pos}</td><td class="num">${money(p.salary)}</td></tr>`)
      .join("");
    return `<h4>${title}</h4><table class="roster-table ${cssClass || ""}"><thead><tr><th>Player</th><th>Pos</th><th>Salary</th></tr></thead><tbody>${body}</tbody></table>`;
  };
  return (
    section("Active Roster", sheet.activeRoster) +
    section("Taxi Squad (doesn't count against cap)", sheet.taxiSquad, "taxi-table") +
    section("Injured Reserve", sheet.ir, "ir-table")
  );
}

function renderRostersPage() {
  const container = $("#rosters-body");
  container.innerHTML = "";
  const rosterIds = Object.keys(CFG.sheetTabsByRosterId).sort(
    (a, b) => (state.sheetByRoster[b]?.cap.remainingCap || 0) - (state.sheetByRoster[a]?.cap.remainingCap || 0)
  );
  for (const rid of rosterIds) {
    const sheet = state.sheetByRoster[rid];
    if (!sheet) continue;
    const card = document.createElement("details");
    card.className = "roster-card";
    card.innerHTML = `
      <summary>${teamName(Number(rid))} — <span class="muted-note">${money(sheet.cap.remainingCap)} remaining</span></summary>
      ${rosterTableHTML(sheet)}
    `;
    container.appendChild(card);
  }
}

/* ---------- Leaderboards ---------- */

function allActiveRosterEntries() {
  const out = [];
  for (const rid of Object.keys(state.sheetByRoster)) {
    const sheet = state.sheetByRoster[rid];
    for (const p of sheet.activeRoster) {
      out.push({ ...p, rosterId: Number(rid) });
    }
  }
  return out;
}

function leaderboardRowHTML(rank, primary, secondary, valueLabel, negative) {
  return `
    <div class="lb-row">
      <span class="lb-rank">${rank}</span>
      <span class="lb-main">
        <span class="lb-player">${primary}</span>
        <span class="lb-sub">${secondary}</span>
      </span>
      <span class="lb-value${negative ? " lb-value-negative" : ""}">${valueLabel}</span>
    </div>
  `;
}

function renderLeaderboards() {
  const entries = allActiveRosterEntries().filter((p) => p.salary > 0);

  // Best value: points per dollar
  const valueRanked = entries
    .map((p) => {
      const pid = playerIdForName(p.name);
      const pts = pid ? state.pointsByPlayer.get(pid) || 0 : 0;
      return { ...p, pts, value: pts / p.salary };
    })
    .filter((p) => p.pts > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  $("#lb-value").innerHTML = valueRanked
    .map((p, i) =>
      leaderboardRowHTML(
        i + 1,
        `${p.name} (${p.pos})`,
        `${teamName(p.rosterId)} · ${money(p.salary)} salary · ${p.pts.toFixed(1)} pts`,
        `${p.value.toFixed(2)} pts/$`,
        p.value < 0
      )
    )
    .join("") || '<div class="empty-state">Not enough stats yet this season.</div>';

  // Highest paid
  const highest = [...entries].sort((a, b) => b.salary - a.salary).slice(0, 10);
  $("#lb-highest").innerHTML = highest
    .map((p, i) => leaderboardRowHTML(i + 1, `${p.name} (${p.pos})`, teamName(p.rosterId), money(p.salary)))
    .join("");

  // Dead cap wall
  const deadCapRanked = Object.keys(state.sheetByRoster)
    .map((rid) => ({ rid: Number(rid), deadCap: state.sheetByRoster[rid].cap.deadCap }))
    .filter((x) => x.deadCap > 0)
    .sort((a, b) => b.deadCap - a.deadCap);

  $("#lb-deadcap").innerHTML =
    deadCapRanked
      .map((x, i) => leaderboardRowHTML(i + 1, teamName(x.rid), "Dead cap absorbed", money(x.deadCap)))
      .join("") || '<div class="empty-state">No dead cap on any roster right now.</div>';

  // Biggest busts: worst points-per-dollar among meaningful salaries.
  const bustRanked = entries
    .filter((p) => p.salary >= 10)
    .map((p) => {
      const pid = playerIdForName(p.name);
      const pts = pid ? state.pointsByPlayer.get(pid) || 0 : 0;
      return { ...p, pts, value: pts / p.salary };
    })
    .sort((a, b) => a.value - b.value)
    .slice(0, 10);

  $("#lb-bust").innerHTML =
    bustRanked
      .map((p, i) =>
        leaderboardRowHTML(
          i + 1,
          `${p.name} (${p.pos})`,
          `${teamName(p.rosterId)} · ${money(p.salary)} salary · ${p.pts.toFixed(1)} pts`,
          `${p.value.toFixed(2)} pts/$`,
          p.value < 0
        )
      )
      .join("") || '<div class="empty-state">Not enough stats yet this season.</div>';

  // Best waiver pickups: cheapest winning FAAB bids (amount !== null, incl.
  // $0 wins) still producing points, for players still on an active roster.
  const activeByPlayerId = new Map();
  for (const p of entries) {
    const pid = playerIdForName(p.name);
    if (pid) activeByPlayerId.set(pid, p);
  }
  const waiverAdds = new Map(); // player_id -> most recent qualifying add event
  for (const ev of state.events) {
    if (ev.type !== "add" || ev.amount == null) continue;
    const pid = ev.playerIds && ev.playerIds[0];
    if (!pid || !activeByPlayerId.has(pid)) continue;
    const prev = waiverAdds.get(pid);
    if (!prev || (ev.date || 0) > (prev.date || 0)) waiverAdds.set(pid, ev);
  }
  const waiverRanked = Array.from(waiverAdds.entries())
    .map(([pid, ev]) => {
      const rosterEntry = activeByPlayerId.get(pid);
      const pts = state.pointsByPlayer.get(pid) || 0;
      const cost = Math.max(ev.amount, 1);
      return {
        name: rosterEntry.name,
        pos: rosterEntry.pos,
        rosterId: ev.rosterIds[0],
        bid: ev.amount,
        addedDate: ev.date,
        pts,
        value: pts / cost,
      };
    })
    .filter((p) => p.pts > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  $("#lb-waiver").innerHTML =
    waiverRanked
      .map((p, i) => {
        const addedLabel = p.addedDate
          ? new Date(p.addedDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          : "unknown date";
        return leaderboardRowHTML(
          i + 1,
          `${p.name} (${p.pos})`,
          `${teamName(p.rosterId)} · $${p.bid} FAAB · added ${addedLabel} · ${p.pts.toFixed(1)} pts`,
          `${p.value.toFixed(2)} pts/$`,
          p.value < 0
        );
      })
      .join("") || '<div class="empty-state">No paid waiver claims found yet this season.</div>';

  // Most improved: PPG in the most recent weeks vs. the season's first half,
  // for players currently on an active roster with enough games in both
  // windows to make the comparison meaningful.
  const week = (state.league && state.league.settings && state.league.settings.leg) || 1;
  const splitWeek = Math.max(1, Math.floor(week / 2));
  const improvedRanked = entries
    .map((p) => {
      const pid = playerIdForName(p.name);
      const weekly = pid ? state.weeklyPointsByPlayer.get(pid) : null;
      if (!weekly) return null;
      let earlyPts = 0, earlyGames = 0, recentPts = 0, recentGames = 0;
      weekly.forEach((pts, w) => {
        if (w <= splitWeek) { earlyPts += pts; earlyGames++; }
        else if (w <= week) { recentPts += pts; recentGames++; }
      });
      if (earlyGames < 2 || recentGames < 2) return null;
      const earlyPPG = earlyPts / earlyGames;
      const recentPPG = recentPts / recentGames;
      return { ...p, earlyPPG, recentPPG, improvement: recentPPG - earlyPPG };
    })
    .filter(Boolean)
    .sort((a, b) => b.improvement - a.improvement)
    .slice(0, 10);

  $("#lb-improved").innerHTML =
    improvedRanked
      .map((p, i) =>
        leaderboardRowHTML(
          i + 1,
          `${p.name} (${p.pos})`,
          `${teamName(p.rosterId)} · ${p.earlyPPG.toFixed(1)} → ${p.recentPPG.toFixed(1)} PPG`,
          `${p.improvement >= 0 ? "+" : ""}${p.improvement.toFixed(1)} PPG`,
          p.improvement < 0
        )
      )
      .join("") || '<div class="empty-state">Not enough weeks played yet to compare trends.</div>';

  // Most active traders: trade-event count per roster, this season.
  const tradeCounts = new Map();
  for (const ev of state.events) {
    if (ev.type !== "trade") continue;
    for (const rid of ev.rosterIds || []) {
      tradeCounts.set(rid, (tradeCounts.get(rid) || 0) + 1);
    }
  }
  const tradersRanked = Array.from(tradeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  $("#lb-traders").innerHTML =
    tradersRanked
      .map(([rid, count], i) => leaderboardRowHTML(i + 1, teamName(rid), "Trades this season", String(count)))
      .join("") || '<div class="empty-state">No trades yet this season.</div>';
}

/* ---------- Trade Machine ---------- */

function renderTradeSide(side) {
  const container = $(`#trade-side-${side.toLowerCase()}`);
  const rosterIds = Object.keys(CFG.sheetTabsByRosterId);

  const teamOptions = rosterIds
    .map((rid) => `<option value="${rid}">${teamName(Number(rid))}</option>`)
    .join("");

  container.innerHTML = `
    <div class="control-group">
      <label>Team ${side}</label>
      <select class="trade-team-select" data-side="${side}">
        <option value="">Choose a team…</option>
        ${teamOptions}
      </select>
    </div>
    <div class="trade-roster-list" data-side="${side}"></div>
    <div class="trade-summary" data-side="${side}"></div>
  `;

  container.querySelector(".trade-team-select").addEventListener("change", (e) => {
    state.trade[`team${side}`] = e.target.value || null;
    renderTradeRosterList(side);
    recomputeTrade();
  });
}

function renderTradeRosterList(side) {
  const rid = state.trade[`team${side}`];
  const listEl = document.querySelector(`.trade-roster-list[data-side="${side}"]`);
  if (!rid) {
    listEl.innerHTML = "";
    return;
  }
  const sheet = state.sheetByRoster[rid];
  if (!sheet) {
    listEl.innerHTML = '<p class="muted-note">No salary data for this team.</p>';
    return;
  }

  listEl.innerHTML = sheet.activeRoster
    .map((p) => {
      const key = `${side}:${p.name}`;
      const maxRetain = Math.min(CFG.maxRetainedSalary, p.salary);
      return `
        <label class="trade-player-row">
          <input type="checkbox" class="trade-player-check" data-side="${side}" data-key="${key}" data-salary="${p.salary}">
          <span class="trade-player-name">${p.name} (${p.pos})</span>
          <span class="trade-player-salary">${money(p.salary)}</span>
          <span class="trade-retain">
            Retain $<input type="number" min="0" max="${maxRetain}" value="0" class="trade-retain-input" data-side="${side}" data-key="${key}" disabled>
          </span>
        </label>
      `;
    })
    .join("");

  listEl.querySelectorAll(".trade-player-check").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const key = e.target.dataset.key;
      const retainInput = listEl.querySelector(`.trade-retain-input[data-key="${CSS.escape(key)}"]`);
      retainInput.disabled = !e.target.checked;
      if (!e.target.checked) {
        delete state.trade.retained[key];
        retainInput.value = 0;
      }
      recomputeTrade();
    })
  );
  listEl.querySelectorAll(".trade-retain-input").forEach((inp) =>
    inp.addEventListener("input", (e) => {
      state.trade.retained[e.target.dataset.key] = Number(e.target.value) || 0;
      recomputeTrade();
    })
  );
}

function recomputeTrade() {
  const ridA = state.trade.teamA;
  const ridB = state.trade.teamB;
  const summaryA = document.querySelector('.trade-summary[data-side="A"]');
  const summaryB = document.querySelector('.trade-summary[data-side="B"]');
  if (!ridA || !ridB || !summaryA || !summaryB) {
    if (summaryA) summaryA.innerHTML = "";
    if (summaryB) summaryB.innerHTML = "";
    return;
  }

  const netMove = (side) => {
    const checks = document.querySelectorAll(`.trade-player-check[data-side="${side}"]:checked`);
    let total = 0;
    checks.forEach((cb) => {
      const salary = Number(cb.dataset.salary);
      const retained = state.trade.retained[cb.dataset.key] || 0;
      total += salary - retained;
    });
    return total;
  };

  const moveFromA = netMove("A"); // cap that leaves A's books, lands on B's
  const moveFromB = netMove("B");

  const capA = state.sheetByRoster[ridA].cap;
  const capB = state.sheetByRoster[ridB].cap;

  const newRemainingA = capA.remainingCap + moveFromA - moveFromB;
  const newRemainingB = capB.remainingCap + moveFromB - moveFromA;

  const summaryHTML = (teamLabel, current, next) => `
    <div class="trade-result">
      <div>${teamLabel} remaining cap</div>
      <div class="trade-result-nums">
        <span>${money(current)}</span> → <span class="${next < 0 ? "over-cap-text" : "ok-cap-text"}">${money(next)}</span>
        ${next < 0 ? '<span class="badge over-cap-badge">⚠ OVER CAP</span>' : ""}
      </div>
    </div>
  `;

  summaryA.innerHTML = summaryHTML(teamName(Number(ridA)), capA.remainingCap, newRemainingA);
  summaryB.innerHTML = summaryHTML(teamName(Number(ridB)), capB.remainingCap, newRemainingB);
}

function initTradeMachine() {
  renderTradeSide("A");
  renderTradeSide("B");
}

/* ---------- Head-to-Head / Trophy Room (lazy-loaded) ---------- */

// Walks the league's previous_league_id chain back to its root season.
// Returns league objects, most recent season first.
async function collectSeasonChain() {
  const chain = [];
  let leagueId = CFG.leagueId;
  const seen = new Set();
  while (leagueId && !seen.has(leagueId)) {
    seen.add(leagueId);
    const league = await fetchJSON(`${API}/league/${leagueId}`);
    chain.push(league);
    leagueId = league.previous_league_id || null;
  }
  return chain;
}

// Aggregates all-time head-to-head records, playoff appearances, and
// trophies (championship / runner-up / 3rd place) per manager, keyed by
// Sleeper's stable user_id (not roster_id, which is season-scoped and can
// be reassigned when a franchise changes hands).
const TWO_SEASONS_MS = 2 * 365 * 24 * 3600 * 1000;

async function buildH2HData() {
  const chain = await collectSeasonChain();
  const userInfo = new Map(); // user_id -> { name, avatar }
  const records = new Map(); // `${a}|${b}` -> { wins, losses, ties } (a's record vs b)
  const trophies = new Map(); // user_id -> { championships, runnerups, thirds, playoffs, seasons: [] }
  const lb = new Map(); // user_id -> career leaderboard stats (see ensureLB)
  const dropsByUserPlayer = new Map(); // `${uid}|${playerId}` -> earliest drop timestamp by that owner
  const rookiePicks = []; // { uid, playerId, draftDate, season } — for conversion-rate scoring after the full chain is walked
  const CONCURRENCY = 6;

  const ensureUser = (uid, name, avatar) => {
    if (!uid) return;
    const prev = userInfo.get(uid) || {};
    userInfo.set(uid, { name: name || prev.name || `Manager ${uid}`, avatar: avatar || prev.avatar || null });
  };
  const ensureTrophy = (uid) => {
    if (!trophies.has(uid)) trophies.set(uid, { championships: 0, runnerups: 0, thirds: 0, playoffs: 0, seasons: [] });
    return trophies.get(uid);
  };
  const ensureLB = (uid) => {
    if (!lb.has(uid)) {
      lb.set(uid, {
        wins: 0, losses: 0, ties: 0,
        top3Seasons: 0, firstSeedSeasons: 0, trades: 0,
        actualPF: 0, maxPF: 0,
      });
    }
    return lb.get(uid);
  };
  const bump = (a, b, result) => {
    const key = `${a}|${b}`;
    if (!records.has(key)) records.set(key, { wins: 0, losses: 0, ties: 0 });
    records.get(key)[result]++;
  };

  for (const league of chain) {
    const leagueId = league.league_id;
    const season = league.season;
    let users, rosters;
    try {
      [users, rosters] = await Promise.all([
        fetchJSON(`${API}/league/${leagueId}/users`),
        fetchJSON(`${API}/league/${leagueId}/rosters`),
      ]);
    } catch (err) {
      console.error(`H2H: users/rosters failed for season ${season}`, err);
      continue;
    }

    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const rosterToUser = new Map(); // roster_id -> user_id, this season only
    const seasonTeams = []; // for seeding: { rid, wins, losses, ties, pointsFor }
    for (const r of rosters) {
      if (!r.owner_id) continue;
      rosterToUser.set(r.roster_id, r.owner_id);
      const u = userMap.get(r.owner_id) || {};
      // Use the owner's Sleeper username rather than that season's team name —
      // team names get rebranded over the years, but the username is the
      // stable identity a manager keeps across every season.
      const ownerLabel = u.display_name || `Manager ${r.owner_id}`;
      ensureUser(r.owner_id, ownerLabel, u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null);

      const s = r.settings || {};
      const wins = s.wins || 0;
      const losses = s.losses || 0;
      const ties = s.ties || 0;
      const pointsFor = (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
      seasonTeams.push({ rid: r.roster_id, wins, losses, ties, pointsFor });
      const career = ensureLB(r.owner_id);
      career.wins += wins;
      career.losses += losses;
      career.ties += ties;
    }

    // Regular-season #1 seed and top-3 scoring teams, per season.
    if (seasonTeams.length) {
      const seeded = seedTeams(seasonTeams);
      const firstSeedUid = rosterToUser.get(seeded[0].rid);
      if (firstSeedUid) ensureLB(firstSeedUid).firstSeedSeasons++;

      const byPoints = [...seasonTeams].sort((a, b) => b.pointsFor - a.pointsFor).slice(0, 3);
      for (const t of byPoints) {
        const uid = rosterToUser.get(t.rid);
        if (uid) ensureLB(uid).top3Seasons++;
      }
    }

    // Weekly matchups: head-to-head pairwise results, plus actual-PF and
    // Max-PF (optimal-lineup) totals for the career coaching-efficiency stat.
    const maxWeek = CFG.maxWeek || 18;
    const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
    const weekResults = [];
    for (let i = 0; i < weeks.length; i += CONCURRENCY) {
      const slice = weeks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((w) => fetchJSON(`${API}/league/${leagueId}/matchups/${w}`).catch(() => []))
      );
      weekResults.push(...results);
    }

    for (const wk of weekResults) {
      if (!Array.isArray(wk) || !wk.length) continue;
      const byMatchup = new Map();
      for (const entry of wk) {
        if (entry.matchup_id == null) continue;
        if (!byMatchup.has(entry.matchup_id)) byMatchup.set(entry.matchup_id, []);
        byMatchup.get(entry.matchup_id).push(entry);
      }
      for (const entry of wk) {
        const uid = rosterToUser.get(entry.roster_id);
        if (!uid) continue;
        const actual = entry.points || 0;
        if (actual <= 0) continue; // week not played yet
        const optimal = computeOptimalLineupPoints(entry.players || [], entry.players_points || {}, league.roster_positions || []);
        const career = ensureLB(uid);
        career.actualPF += actual;
        career.maxPF += Math.max(optimal, actual);
      }
      for (const pair of byMatchup.values()) {
        if (pair.length !== 2) continue;
        const [x, y] = pair;
        const uX = rosterToUser.get(x.roster_id);
        const uY = rosterToUser.get(y.roster_id);
        if (!uX || !uY) continue;
        const px = x.points || 0;
        const py = y.points || 0;
        if (px === py) {
          bump(uX, uY, "ties");
          bump(uY, uX, "ties");
        } else if (px > py) {
          bump(uX, uY, "wins");
          bump(uY, uX, "losses");
        } else {
          bump(uX, uY, "losses");
          bump(uY, uX, "wins");
        }
      }
    }

    // Weekly transactions: trade counts, plus a drop-event index used to
    // score draft-pick conversion (was a rookie pick released by the same
    // GM within two seasons, or did it stick as a long-term asset?).
    const txResults = [];
    for (let i = 0; i < weeks.length; i += CONCURRENCY) {
      const slice = weeks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((w) => fetchJSON(`${API}/league/${leagueId}/transactions/${w}`).catch(() => []))
      );
      txResults.push(...results.flat());
    }
    const seenTradeIds = new Set();
    for (const tx of txResults) {
      const ts = tx.status_updated || tx.created;
      if (tx.type === "trade" && tx.status === "complete" && !seenTradeIds.has(tx.transaction_id)) {
        seenTradeIds.add(tx.transaction_id);
        for (const rid of tx.roster_ids || []) {
          const uid = rosterToUser.get(rid);
          if (uid) ensureLB(uid).trades++;
        }
      }
      if (tx.drops && ts) {
        for (const [playerId, rid] of Object.entries(tx.drops)) {
          const uid = rosterToUser.get(rid);
          if (!uid) continue;
          const key = `${uid}|${playerId}`;
          const prev = dropsByUserPlayer.get(key);
          if (prev == null || ts < prev) dropsByUserPlayer.set(key, ts);
        }
      }
    }

    // Rookie-draft picks: who drafted whom, and when, so it can be scored
    // for conversion once every season has been walked.
    try {
      const seasonDrafts = await fetchJSON(`${API}/league/${leagueId}/drafts`);
      const draft = pickRookieDraft(seasonDrafts);
      const draftDate = draft && (draft.start_time || draft.last_picked);
      if (draft && draftDate) {
        let picks = [];
        try {
          picks = await fetchJSON(`${API}/draft/${draft.draft_id}/picks`);
        } catch (err) {
          picks = [];
        }
        for (const p of picks || []) {
          if (!p.player_id) continue;
          const uid = rosterToUser.get(p.roster_id);
          if (!uid) continue;
          rookiePicks.push({ uid, playerId: p.player_id, draftDate, season });
        }
      }
    } catch (err) {
      console.error(`H2H: drafts failed for season ${season}`, err);
    }

    try {
      const bracket = await fetchJSON(`${API}/league/${leagueId}/winners_bracket`);
      const seenPlayoffUsers = new Set();
      for (const m of bracket || []) {
        [m.t1, m.t2].forEach((rid) => {
          if (rid == null) return;
          const uid = rosterToUser.get(rid);
          if (uid) seenPlayoffUsers.add(uid);
        });
        if (m.p === 1 && m.w != null) {
          const champUid = rosterToUser.get(m.w);
          const runnerUid = m.l != null ? rosterToUser.get(m.l) : null;
          if (champUid) ensureTrophy(champUid).championships++;
          if (runnerUid) ensureTrophy(runnerUid).runnerups++;
        }
        if (m.p === 3 && m.w != null) {
          const thirdUid = rosterToUser.get(m.w);
          if (thirdUid) ensureTrophy(thirdUid).thirds++;
        }
      }
      seenPlayoffUsers.forEach((uid) => {
        const t = ensureTrophy(uid);
        t.playoffs++;
        t.seasons.push(season);
      });
    } catch (err) {
      console.error(`H2H: bracket failed for season ${season}`, err);
    }
  }

  // Score draft-pick conversion now that every season's drops are indexed.
  // "Converted" = the GM who drafted this player never released him within
  // two seasons (he either became a long-term piece or was traded for value
  // — either way, they didn't just cut a bust). Only picks old enough for
  // two seasons to have actually elapsed count toward the rate.
  const now = Date.now();
  for (const pick of rookiePicks) {
    if (now - pick.draftDate < TWO_SEASONS_MS) continue; // too recent to judge yet
    const career = ensureLB(pick.uid);
    career.picksEligible = (career.picksEligible || 0) + 1;
    career.picksConverted = career.picksConverted || 0;
    const droppedAt = dropsByUserPlayer.get(`${pick.uid}|${pick.playerId}`);
    if (droppedAt == null || droppedAt - pick.draftDate > TWO_SEASONS_MS) {
      career.picksConverted++;
    }
  }

  return {
    userInfo,
    records,
    trophies,
    leaderboard: lb,
    seasonsCovered: chain.map((l) => l.season),
  };
}

function h2hCardHTML(c) {
  const { info, t } = c;
  return `
    <div class="h2h-card" data-uid="${c.uid}" tabindex="0" role="button">
      ${info.avatar ? `<img class="h2h-avatar" src="${info.avatar}" alt="">` : '<span class="h2h-avatar h2h-avatar-blank"></span>'}
      <div class="h2h-name">${info.name}</div>
      <div class="h2h-badges">
        ${t.championships ? `<span class="h2h-badge h2h-badge-champ" title="${t.championships} Championship${t.championships > 1 ? "s" : ""}">🏆 ${t.championships}</span>` : ""}
        ${t.runnerups ? `<span class="h2h-badge" title="${t.runnerups} Runner-up${t.runnerups > 1 ? "s" : ""}">🥈 ${t.runnerups}</span>` : ""}
        ${t.thirds ? `<span class="h2h-badge" title="${t.thirds}× 3rd Place">🥉 ${t.thirds}</span>` : ""}
        <span class="h2h-badge h2h-badge-muted" title="Playoff appearances">⛳ ${t.playoffs}</span>
      </div>
      <div class="h2h-card-hint">Click for head-to-head ▸</div>
    </div>
  `;
}

function openH2HDrawer(uid, data, cards) {
  const me = cards.find((c) => c.uid === uid);
  if (!me) return;
  const rows = cards
    .filter((c) => c.uid !== uid)
    .map((opp) => ({
      name: opp.info.name,
      rec: data.records.get(`${uid}|${opp.uid}`) || { wins: 0, losses: 0, ties: 0 },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const inner = $("#h2h-drawer-inner");
  if (!inner) return;
  inner.innerHTML = `
    <h3 class="h2h-drawer-title">${me.info.name}</h3>
    <p class="h2h-drawer-sub">
      ${me.t.championships} championship${me.t.championships === 1 ? "" : "s"} ·
      ${me.t.runnerups} runner-up${me.t.runnerups === 1 ? "" : "s"} ·
      ${me.t.thirds} 3rd-place finish${me.t.thirds === 1 ? "" : "es"} ·
      ${me.t.playoffs} playoff appearance${me.t.playoffs === 1 ? "" : "s"}
      ${me.t.seasons.length ? `(${me.t.seasons.slice().sort().join(", ")})` : ""}
    </p>
    <table class="h2h-table">
      <thead><tr><th>Opponent</th><th class="num">All-Time Record</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${r.name}</td>
            <td class="num">${r.rec.wins}-${r.rec.losses}${r.rec.ties ? `-${r.rec.ties}` : ""}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
  const drawer = $("#h2h-drawer");
  if (drawer) drawer.hidden = false;
}

function h2hLegendHTML() {
  return `
    <div class="h2h-legend">
      <span class="h2h-legend-item"><span class="h2h-legend-icon">🏆</span> Championships</span>
      <span class="h2h-legend-item"><span class="h2h-legend-icon">🥈</span> Runner-up</span>
      <span class="h2h-legend-item"><span class="h2h-legend-icon">🥉</span> 3rd place</span>
      <span class="h2h-legend-item"><span class="h2h-legend-icon">⛳</span> Playoff appearances</span>
    </div>
  `;
}

function h2hLeaderboardHTML(cards) {
  const rows = [...cards]
    .sort((a, b) => {
      if (b.t.championships !== a.t.championships) return b.t.championships - a.t.championships;
      if (b.t.playoffs !== a.t.playoffs) return b.t.playoffs - a.t.playoffs;
      return b.lb.wins - a.lb.wins;
    })
    .map((c) => {
      const lb = c.lb;
      const finals = c.t.championships + c.t.runnerups;
      const record = `${lb.wins}-${lb.losses}${lb.ties ? `-${lb.ties}` : ""}`;
      const conversion = lb.picksEligible
        ? `${Math.round((lb.picksConverted / lb.picksEligible) * 100)}% (${lb.picksConverted}/${lb.picksEligible})`
        : "—";
      const efficiency = lb.maxPF > 0 ? `${((lb.actualPF / lb.maxPF) * 100).toFixed(1)}%` : "—";
      return `
        <tr>
          <td class="h2h-lb-name">${c.info.name}</td>
          <td class="num">${record}</td>
          <td class="num">${lb.top3Seasons}</td>
          <td class="num">${c.t.playoffs}</td>
          <td class="num">${c.t.championships}</td>
          <td class="num">${finals}</td>
          <td class="num">${lb.firstSeedSeasons}</td>
          <td class="num">${lb.trades}</td>
          <td class="num">${conversion}</td>
          <td class="num">${efficiency}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="h2h-lb-wrap">
      <table class="h2h-lb-table">
        <thead>
          <tr>
            <th>Manager</th>
            <th class="num">Record</th>
            <th class="num">Top-3 Scoring</th>
            <th class="num">Playoffs</th>
            <th class="num">Titles</th>
            <th class="num">Finals</th>
            <th class="num">#1 Seeds</th>
            <th class="num">Trades</th>
            <th class="num">Pick Conversion</th>
            <th class="num">Lineup Efficiency</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="h2h-lb-footnote">
      <strong>Pick Conversion</strong> — rookie picks that manager never released within two seasons of drafting
      them, out of picks old enough to judge (recent rookie picks aren't scored yet). <strong>Lineup Efficiency</strong> —
      actual points scored ÷ the optimal lineup's points, career-wide; a high number means a manager who rarely
      leaves points on the bench.
    </p>
  `;
}

function renderH2HPage(data) {
  const container = $("#h2h-body");
  if (!container) return;

  const currentUserIds = Array.from(new Set(Array.from(state.rosterMap.values()).map((r) => r.ownerId)));
  const cards = currentUserIds.map((uid) => ({
    uid,
    info: data.userInfo.get(uid) || { name: `Manager ${uid}`, avatar: null },
    t: data.trophies.get(uid) || { championships: 0, runnerups: 0, thirds: 0, playoffs: 0, seasons: [] },
    lb: data.leaderboard.get(uid) || {
      wins: 0, losses: 0, ties: 0, top3Seasons: 0, firstSeedSeasons: 0, trades: 0,
      actualPF: 0, maxPF: 0, picksConverted: 0, picksEligible: 0,
    },
  }));

  const seasons = data.seasonsCovered.slice().sort();

  container.innerHTML = `
    <p class="page-sub">
      All-time history across ${seasons.length} season${seasons.length === 1 ? "" : "s"}
      (${seasons[0]}–${seasons[seasons.length - 1]}).
    </p>
    <h3 class="h2h-section-title">Career Leaderboard</h3>
    ${h2hLeaderboardHTML(cards)}
    <h3 class="h2h-section-title">Manager Cards</h3>
    <p class="page-sub">Click a manager for their full head-to-head breakdown.</p>
    ${h2hLegendHTML()}
    <div class="h2h-grid">${cards.map((c) => h2hCardHTML(c)).join("")}</div>
    <div class="h2h-drawer" id="h2h-drawer" hidden>
      <div class="h2h-drawer-inner" id="h2h-drawer-inner"></div>
      <button class="h2h-drawer-close" id="h2h-drawer-close">✕ Close</button>
    </div>
  `;

  container.querySelectorAll(".h2h-card").forEach((card) => {
    const open = () => openH2HDrawer(card.dataset.uid, data, cards);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  const closeBtn = $("#h2h-drawer-close");
  if (closeBtn) closeBtn.addEventListener("click", () => { $("#h2h-drawer").hidden = true; });
}

async function loadAndRenderH2H() {
  if (state.h2h.loaded || state.h2h.loading) return;
  state.h2h.loading = true;
  const container = $("#h2h-body");
  if (container) {
    container.innerHTML = '<div class="empty-state">Loading all-time head-to-head history (walking every season back to the league\'s founding)…</div>';
  }
  try {
    const data = await buildH2HData();
    state.h2h.data = data;
    state.h2h.loaded = true;
    renderH2HPage(data);
  } catch (err) {
    console.error("H2H load failed:", err);
    if (container) container.innerHTML = '<div class="empty-state">Head-to-head history not available.</div>';
  } finally {
    state.h2h.loading = false;
  }
}

/* ---------- On This Day (lazy-loaded) ---------- */

// Walks the full season chain looking for trades and draft results that
// happened on today's calendar date (month + day, any year). Every trade
// counts as "big" per league consensus — no size filter beyond "it happened."
async function buildOnThisDayData() {
  const chain = await collectSeasonChain();
  const today = new Date();
  const todayMonth = today.getMonth();
  const todayDate = today.getDate();
  const CONCURRENCY = 6;

  const trades = [];
  const drafts = [];

  for (const league of chain) {
    const leagueId = league.league_id;
    const season = league.season;
    let users, rosters;
    try {
      [users, rosters] = await Promise.all([
        fetchJSON(`${API}/league/${leagueId}/users`),
        fetchJSON(`${API}/league/${leagueId}/rosters`),
      ]);
    } catch (err) {
      console.error(`On This Day: users/rosters failed for season ${season}`, err);
      continue;
    }

    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const rosterName = new Map();
    for (const r of rosters) {
      const u = userMap.get(r.owner_id) || {};
      rosterName.set(r.roster_id, (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${r.roster_id}`);
    }

    // Trades: scan every week's transactions for this season.
    const maxWeek = CFG.maxWeek || 18;
    const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
    const weekTx = [];
    for (let i = 0; i < weeks.length; i += CONCURRENCY) {
      const slice = weeks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((w) => fetchJSON(`${API}/league/${leagueId}/transactions/${w}`).catch(() => []))
      );
      weekTx.push(...results.flat());
    }

    const seenTradeIds = new Set();
    for (const tx of weekTx) {
      if (tx.type !== "trade" || tx.status !== "complete") continue;
      if (seenTradeIds.has(tx.transaction_id)) continue;
      seenTradeIds.add(tx.transaction_id);

      const ts = tx.status_updated || tx.created;
      if (!ts) continue;
      const d = new Date(ts);
      if (d.getMonth() !== todayMonth || d.getDate() !== todayDate) continue;

      const rosterIds = tx.roster_ids || [];
      const gains = new Map();
      for (const rid of rosterIds) gains.set(rid, []);
      for (const [pid, rid] of Object.entries(tx.adds || {})) {
        if (!gains.has(rid)) gains.set(rid, []);
        gains.get(rid).push(playerLabel(pid));
      }
      for (const pick of tx.draft_picks || []) {
        const toRoster = pick.owner_id;
        if (!gains.has(toRoster)) gains.set(toRoster, []);
        const round = pick.round;
        const suffix = round === 1 ? "st" : round === 2 ? "nd" : round === 3 ? "rd" : "th";
        const fromName = rosterName.get(pick.roster_id) || `Roster ${pick.roster_id}`;
        gains.get(toRoster).push(`${pick.season} ${round}${suffix}-round pick (${fromName}'s)`);
      }
      for (const move of tx.waiver_budget || []) {
        if (!gains.has(move.receiver)) gains.set(move.receiver, []);
        gains.get(move.receiver).push(`$${move.amount} FAAB`);
      }

      const teams = Array.from(gains.entries()).map(([rid, items]) => ({
        name: rosterName.get(rid) || `Roster ${rid}`,
        gained: items.length ? items : ["nothing notable"],
      }));

      trades.push({ season, date: d, teams });
    }

    // Draft results: any draft (startup or rookie) that ran on this calendar day.
    try {
      const seasonDrafts = await fetchJSON(`${API}/league/${leagueId}/drafts`);
      for (const draft of seasonDrafts || []) {
        const ts = draft.start_time || draft.last_picked;
        if (!ts) continue;
        const d = new Date(ts);
        if (d.getMonth() !== todayMonth || d.getDate() !== todayDate) continue;

        let picks = [];
        try {
          picks = await fetchJSON(`${API}/draft/${draft.draft_id}/picks`);
        } catch (err) {
          console.error(`On This Day: draft picks failed for season ${season}`, err);
          continue;
        }
        if (!picks || !picks.length) continue;

        const teamCount = rosters.length || 10;
        const pickRows = [...picks]
          .sort((a, b) => a.pick_no - b.pick_no)
          .map((p) => {
            const slot = ((p.pick_no - 1) % teamCount) + 1;
            const meta = p.metadata || {};
            const playerName = p.player_id
              ? playerLabel(p.player_id)
              : [meta.first_name, meta.last_name].filter(Boolean).join(" ") || "—";
            return {
              label: `${p.round}.${String(slot).padStart(2, "0")}`,
              team: rosterName.get(p.roster_id) || `Roster ${p.roster_id}`,
              player: playerName,
            };
          });

        drafts.push({ season, date: d, draftType: draft.type || "draft", picks: pickRows });
      }
    } catch (err) {
      console.error(`On This Day: drafts failed for season ${season}`, err);
    }
  }

  trades.sort((a, b) => Number(b.season) - Number(a.season));
  drafts.sort((a, b) => Number(b.season) - Number(a.season));

  return {
    trades,
    drafts,
    todayLabel: today.toLocaleDateString(undefined, { month: "long", day: "numeric" }),
  };
}

function onThisDayHTML(data) {
  if (!data.trades.length && !data.drafts.length) {
    return `<div class="empty-state">Nothing on record happened on ${data.todayLabel} across ${data.trades.length ? "" : "any"} league history — check back tomorrow.</div>`;
  }

  const tradeCards = data.trades
    .map(
      (t) => `
    <div class="otd-card">
      <div class="otd-card-head">
        <span class="otd-badge otd-badge-trade">🔁 Trade</span>
        <span class="otd-year">${t.season}</span>
      </div>
      <div class="otd-trade-teams">
        ${t.teams
          .map(
            (team) => `
          <div class="otd-trade-team">
            <div class="otd-trade-team-name">${team.name}</div>
            <div class="otd-trade-arrow">received</div>
            <ul class="otd-trade-gains">${team.gained.map((g) => `<li>${g}</li>`).join("")}</ul>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `
    )
    .join("");

  const draftCards = data.drafts
    .map(
      (dr) => `
    <div class="otd-card">
      <div class="otd-card-head">
        <span class="otd-badge otd-badge-draft">📋 Draft</span>
        <span class="otd-year">${dr.season}</span>
      </div>
      <table class="roster-table">
        <thead><tr><th>Pick</th><th>Team</th><th>Player</th></tr></thead>
        <tbody>${dr.picks.map((p) => `<tr><td>${p.label}</td><td>${p.team}</td><td>${p.player}</td></tr>`).join("")}</tbody>
      </table>
    </div>
  `
    )
    .join("");

  return `
    <p class="page-sub">Everything on record that happened on ${data.todayLabel} across ${CFG.siteName || "league"} history.</p>
    <div class="otd-list">${tradeCards}${draftCards}</div>
  `;
}

async function loadAndRenderOnThisDay() {
  if (state.onThisDay.loaded || state.onThisDay.loading) return;
  state.onThisDay.loading = true;
  const container = $("#otd-body");
  if (container) {
    container.innerHTML = '<div class="empty-state">Checking every season for what happened on this day…</div>';
  }
  try {
    const data = await buildOnThisDayData();
    state.onThisDay.data = data;
    state.onThisDay.loaded = true;
    if (container) container.innerHTML = onThisDayHTML(data);
  } catch (err) {
    console.error("On This Day load failed:", err);
    if (container) container.innerHTML = '<div class="empty-state">On This Day history not available.</div>';
  } finally {
    state.onThisDay.loading = false;
  }
}

/* ---------- Draft & FA page ---------- */

const ROOKIE_SCHEDULE = [
  ["1.01", "$30"], ["1.02–1.03", "$26"], ["1.04–1.06", "$23"], ["1.07–1.10", "$20"],
  ["2.01–2.03", "$15"], ["2.04–2.07", "$12"], ["2.08–2.10", "$9"],
  ["3.01–3.05", "$6"], ["3.06–3.10", "$5"],
  ["Round 4 (all picks)", "$2"],
];

async function loadTradedPicks(season) {
  try {
    const picks = await fetchJSON(`${API}/league/${CFG.leagueId}/traded_picks`);
    return picks.filter((p) => String(p.season) === String(season));
  } catch (err) {
    console.error("Traded picks load failed:", err);
    return [];
  }
}

// A pick can change hands in a trade from *any* past season (a manager can
// deal away a future rookie pick years in advance), so finding "how was this
// acquired" has to search full league history, not just this season's
// transactions. That's expensive (every season x every week), so it's built
// once, lazily, the first time a traded pick is actually clicked — not on
// every draft-board render — and cached for the rest of the session.
async function buildAllSeasonsTradeIndex() {
  const chain = await collectSeasonChain();
  const CONCURRENCY = 6;
  const index = []; // { ts, draftPicks: [...], teams: [{ name, gained }] }

  const seasonToLeagueId = new Map(chain.map((l) => [String(l.season), l.league_id]));
  const draftInfoCache = new Map(); // leagueId -> { slotToRoster, picksByNo, teamCount } | null

  // A traded pick's original draft slot doesn't move when it's traded — only
  // who makes the pick does — so slot_to_roster_id (fixed at the start of
  // that season's draft) tells us which pick_no was "originalRid's Nth
  // rounder," whoever actually used it.
  async function getDraftInfo(season) {
    const leagueId = seasonToLeagueId.get(String(season));
    if (!leagueId) return null;
    if (draftInfoCache.has(leagueId)) return draftInfoCache.get(leagueId);
    let info = null;
    try {
      const seasonDrafts = await fetchJSON(`${API}/league/${leagueId}/drafts`);
      const draft = pickRookieDraft(seasonDrafts);
      if (draft && draft.slot_to_roster_id) {
        const picks = await fetchJSON(`${API}/draft/${draft.draft_id}/picks`);
        if (picks && picks.length) {
          const picksByNo = new Map(picks.map((p) => [p.pick_no, p]));
          const slotToRoster = new Map(
            Object.entries(draft.slot_to_roster_id).map(([slot, rid]) => [Number(rid), Number(slot)])
          );
          const teamCount = Object.keys(draft.slot_to_roster_id).length || 10;
          info = { slotToRoster, picksByNo, teamCount };
        }
      }
    } catch (err) {
      console.error(`Pick history: draft lookup failed for season ${season}`, err);
    }
    draftInfoCache.set(leagueId, info);
    return info;
  }

  // Resolves a traded pick (by its original owner, season, and round) to the
  // player actually drafted with it — but only once that season's draft has
  // happened; a still-future pick just returns null, same as before.
  async function resolveDraftedPlayer(season, round, originalRid) {
    const info = await getDraftInfo(season);
    if (!info) return null;
    const slot = info.slotToRoster.get(Number(originalRid));
    if (!slot) return null;
    const pickNo = (round - 1) * info.teamCount + slot;
    const pick = info.picksByNo.get(pickNo);
    if (!pick) return null;
    if (pick.player_id) return playerLabel(pick.player_id);
    const meta = pick.metadata || {};
    return [meta.first_name, meta.last_name].filter(Boolean).join(" ") || null;
  }

  for (const league of chain) {
    const leagueId = league.league_id;
    let users, rosters;
    try {
      [users, rosters] = await Promise.all([
        fetchJSON(`${API}/league/${leagueId}/users`),
        fetchJSON(`${API}/league/${leagueId}/rosters`),
      ]);
    } catch (err) {
      console.error(`Pick history: users/rosters failed for league ${leagueId}`, err);
      continue;
    }
    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const rosterName = new Map(); // roster_id -> team name, as it was THAT season
    for (const r of rosters) {
      const u = userMap.get(r.owner_id) || {};
      rosterName.set(r.roster_id, (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${r.roster_id}`);
    }

    const maxWeek = CFG.maxWeek || 18;
    const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1);
    const weekTx = [];
    for (let i = 0; i < weeks.length; i += CONCURRENCY) {
      const slice = weeks.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map((w) => fetchJSON(`${API}/league/${leagueId}/transactions/${w}`).catch(() => []))
      );
      weekTx.push(...results.flat());
    }

    const seen = new Set();
    for (const tx of weekTx) {
      if (tx.type !== "trade" || tx.status !== "complete") continue;
      if (seen.has(tx.transaction_id)) continue;
      seen.add(tx.transaction_id);
      if (!tx.draft_picks || !tx.draft_picks.length) continue; // only pick-moving trades matter here

      const rosterIds = tx.roster_ids || [];
      const gains = new Map();
      for (const rid of rosterIds) gains.set(rid, []);
      for (const [pid, rid] of Object.entries(tx.adds || {})) {
        if (!gains.has(rid)) gains.set(rid, []);
        gains.get(rid).push(playerLabel(pid));
      }
      for (const pick of tx.draft_picks) {
        const toRoster = pick.owner_id;
        if (!gains.has(toRoster)) gains.set(toRoster, []);
        const suffix = pick.round === 1 ? "st" : pick.round === 2 ? "nd" : pick.round === 3 ? "rd" : "th";
        const fromName = rosterName.get(pick.roster_id) || `Roster ${pick.roster_id}`;
        let label = `${pick.season} ${pick.round}${suffix}-round pick (${fromName}'s)`;
        const drafted = await resolveDraftedPlayer(pick.season, pick.round, pick.roster_id);
        if (drafted) label += ` — became ${drafted}`;
        gains.get(toRoster).push(label);
      }
      for (const move of tx.waiver_budget || []) {
        if (!gains.has(move.receiver)) gains.set(move.receiver, []);
        gains.get(move.receiver).push(`$${move.amount} FAAB`);
      }

      const teams = Array.from(gains.entries()).map(([rid, items]) => ({
        name: rosterName.get(rid) || `Roster ${rid}`,
        gained: items.length ? items : ["nothing notable"],
      }));

      index.push({ ts: tx.status_updated || tx.created || 0, draftPicks: tx.draft_picks, teams });
    }
  }

  return index;
}

// Finds how a (traded) pick ended up with its current owner. Sleeper's
// traded_picks endpoint only reports the final owner, not the history, so if
// a pick changed hands more than once this returns the most recent trade
// that routed it to its current owner.
async function findPickAcquisition(originalRid, round, season, ownerRid) {
  if (ownerRid === originalRid) return { type: "original" };

  if (!state.allSeasonsTradeIndexPromise) {
    state.allSeasonsTradeIndexPromise = buildAllSeasonsTradeIndex();
  }
  let index;
  try {
    index = await state.allSeasonsTradeIndexPromise;
  } catch (err) {
    console.error("Pick history lookup failed:", err);
    state.allSeasonsTradeIndexPromise = null; // allow a retry on the next click
    return { type: "error" };
  }

  let match = null;
  for (const entry of index) {
    const hit = entry.draftPicks.some(
      (p) => String(p.season) === String(season) && p.round === round && p.roster_id === originalRid && p.owner_id === ownerRid
    );
    if (!hit) continue;
    if (!match || entry.ts > match.ts) match = entry;
  }
  if (!match) return { type: "unknown" };
  return { type: "trade", date: match.ts, teams: match.teams };
}

// Builds the 4-round / 40-pick rookie draft order for next season.
// Picks 1-4: the 4 non-playoff teams (seeds 7-10), ordered by Max PF
// ascending (lowest Max PF picks first). Picks 5-10: the 6 playoff teams
// (seeds 1-6), worst-seed-first (seed 6 -> pick 5 ... seed 1 -> pick 10).
// Pick ownership is resolved against traded_picks for that season; a traded
// pick shows the current owner with a "via <original owner>" note.
async function buildDraftBoard() {
  const ranked = getStandingsRanked();
  if (!ranked.length || !state.league) return null;

  const maxPF = state.standingsExtra.maxPFByRoster;
  const playoffSeeds = ranked.slice(0, 6); // seeds 1-6, in seed order
  const lotterySeeds = ranked.slice(6, 10); // seeds 7-10

  const lotteryOrder = [...lotterySeeds].sort(
    (a, b) => (maxPF.get(a.rid) || 0) - (maxPF.get(b.rid) || 0)
  );
  const playoffOrder = [...playoffSeeds].reverse(); // seed 6 first, seed 1 last

  const round1Order = [...lotteryOrder, ...playoffOrder]; // 10 original-owner roster_ids, pick order

  const nextSeason = String(Number(state.league.season) + 1);
  const tradedPicks = await loadTradedPicks(nextSeason);
  const tradeMap = new Map(); // `${round}:${roster_id}` -> owner_id
  for (const tp of tradedPicks) {
    tradeMap.set(`${tp.round}:${tp.roster_id}`, tp.owner_id);
  }

  const rounds = [];
  for (let round = 1; round <= 4; round++) {
    const picks = round1Order.map((team, idx) => {
      const originalRid = team.rid;
      const ownerRid = tradeMap.has(`${round}:${originalRid}`)
        ? tradeMap.get(`${round}:${originalRid}`)
        : originalRid;
      const traded = ownerRid !== originalRid;
      const owner = state.rosterMap.get(ownerRid) || state.rosterMap.get(Number(ownerRid));
      const original = state.rosterMap.get(originalRid) || state.rosterMap.get(Number(originalRid));
      return {
        label: `${round}.${String(idx + 1).padStart(2, "0")}`,
        ownerName: owner ? owner.name : `Roster ${ownerRid}`,
        ownerAvatar: owner ? owner.avatar : null,
        traded,
        originalName: original ? original.name : `Roster ${originalRid}`,
        // Resolved lazily on click (searching full league history is expensive) — see openDraftPickDrawer.
        originalRid,
        ownerRid,
        round,
        season: nextSeason,
        acquisition: null,
      };
    });
    rounds.push({ round, picks });
  }

  return { season: nextSeason, rounds };
}

function draftBoardHTML(board) {
  if (!board) return '<div class="empty-state">Draft board not available yet.</div>';
  return `
    <p class="page-sub">
      ${board.season} rookie draft order — picks 1–4 set by Max PF (lowest picks first),
      picks 5–10 set by current playoff seed (worst seed picks first). Updates live as
      standings and traded picks change. Click any pick to see how it was acquired.
    </p>
    <div class="draft-board">
      ${board.rounds
        .map(
          (r) => `
        <div class="draft-round">
          <h3 class="draft-round-title">Round ${r.round}</h3>
          <div class="draft-round-picks">
            ${r.picks
              .map(
                (p, idx) => `
              <div class="draft-pick-card ${p.traded ? "draft-pick-traded" : ""}" data-round="${r.round}" data-idx="${idx}" tabindex="0" role="button">
                <span class="draft-pick-num">${p.label}</span>
                ${p.ownerAvatar ? `<img class="draft-pick-avatar" src="${p.ownerAvatar}" alt="">` : ""}
                <span class="draft-pick-team">${p.ownerName}</span>
                ${p.traded ? `<span class="draft-pick-via">via ${p.originalName}</span>` : ""}
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `
        )
        .join("")}
    </div>
    <div class="h2h-drawer" id="draft-drawer" hidden>
      <div class="h2h-drawer-inner" id="draft-drawer-inner"></div>
      <button class="h2h-drawer-close" id="draft-drawer-close">✕ Close</button>
    </div>
  `;
}

let draftDrawerToken = 0;

// Traded picks are resolved lazily (searching full league history is
// expensive), so this shows the drawer immediately with a loading note,
// then fills in the trade once it's found — caching the result on the pick
// itself so re-opening the same card later is instant.
async function openDraftPickDrawer(pick) {
  const inner = $("#draft-drawer-inner");
  const drawer = $("#draft-drawer");
  if (!inner || !drawer) return;

  const myToken = ++draftDrawerToken;
  drawer.hidden = false;
  inner.innerHTML = `
    <h3 class="h2h-drawer-title">Pick ${pick.label}</h3>
    <p class="h2h-drawer-sub">Currently owned by ${pick.ownerName}</p>
    ${pick.traded && !pick.acquisition ? '<p class="h2h-drawer-sub">Looking up trade history across every past season…</p>' : ""}
  `;

  let acq = pick.acquisition;
  if (!acq) {
    acq = await findPickAcquisition(pick.originalRid, pick.round, pick.season, pick.ownerRid);
    pick.acquisition = acq; // cache so re-opening this card is instant
  }
  if (myToken !== draftDrawerToken) return; // a different pick was opened while this was loading

  let bodyHtml;
  if (acq.type === "original") {
    bodyHtml = `<p class="h2h-drawer-sub">${pick.originalName}'s original pick — never traded.</p>`;
  } else if (acq.type === "trade") {
    const dateLabel = acq.date
      ? new Date(acq.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "";
    bodyHtml = `
      <p class="h2h-drawer-sub">Acquired in a trade${dateLabel ? ` on ${dateLabel}` : ""}:</p>
      <div class="otd-trade-teams">
        ${acq.teams
          .map(
            (team) => `
          <div class="otd-trade-team">
            <div class="otd-trade-team-name">${team.name}</div>
            <div class="otd-trade-arrow">received</div>
            <ul class="otd-trade-gains">${team.gained.map((g) => `<li>${g}</li>`).join("")}</ul>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  } else if (acq.type === "error") {
    bodyHtml = `<p class="h2h-drawer-sub">Couldn't look up this pick's trade history right now — try again in a moment.</p>`;
  } else {
    bodyHtml = `<p class="h2h-drawer-sub">This pick changed hands, but a matching trade couldn't be found anywhere in the league's transaction history.</p>`;
  }

  inner.innerHTML = `
    <h3 class="h2h-drawer-title">Pick ${pick.label}</h3>
    <p class="h2h-drawer-sub">Currently owned by ${pick.ownerName}</p>
    ${bodyHtml}
  `;
}

function wireDraftBoardClicks(board) {
  if (!board) return;
  document.querySelectorAll(".draft-pick-card").forEach((card) => {
    const round = Number(card.dataset.round);
    const idx = Number(card.dataset.idx);
    const roundData = board.rounds[round - 1];
    const pick = roundData && roundData.picks[idx];
    if (!pick) return;
    const open = () => openDraftPickDrawer(pick);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  const closeBtn = $("#draft-drawer-close");
  if (closeBtn) closeBtn.addEventListener("click", () => { $("#draft-drawer").hidden = true; });
}

async function renderDraftPage() {
  $("#rookie-schedule").innerHTML = `
    <table class="roster-table">
      <thead><tr><th>Pick</th><th>Salary</th></tr></thead>
      <tbody>${ROOKIE_SCHEDULE.map(([pick, sal]) => `<tr><td>${pick}</td><td class="num">${sal}</td></tr>`).join("")}</tbody>
    </table>
  `;

  const faSection = RULEBOOK_SECTIONS.find((s) => s.heading === "In-Season Free Agency");
  const offSection = RULEBOOK_SECTIONS.find((s) => s.heading === "Off-Season Free Agency");
  const bullets = [...(faSection ? faSection.bullets : []), ...(offSection ? offSection.bullets : [])];
  $("#fa-rules").innerHTML = bullets.map((b) => `<li>${b}</li>`).join("");

  const boardEl = $("#draft-board");
  if (boardEl) {
    boardEl.innerHTML = '<div class="empty-state">Loading draft board…</div>';
    try {
      const board = await buildDraftBoard();
      boardEl.innerHTML = draftBoardHTML(board);
      wireDraftBoardClicks(board);
    } catch (err) {
      console.error("Draft board failed:", err);
      boardEl.innerHTML = '<div class="empty-state">Draft board not available.</div>';
    }
  }
}

/* ---------- Rule Book page ---------- */

function renderRulesPage(query) {
  const q = (query || "").trim().toLowerCase();
  const container = $("#rules-body");
  const highlight = (text) => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return text;
    return text.slice(0, idx) + "<mark>" + text.slice(idx, idx + q.length) + "</mark>" + text.slice(idx + q.length);
  };

  const sections = RULEBOOK_SECTIONS.map((s) => {
    const headingMatches = s.heading.toLowerCase().includes(q);
    const bullets = s.bullets.filter((b) => !q || headingMatches || b.toLowerCase().includes(q));
    return { ...s, bullets };
  }).filter((s) => !q || s.bullets.length);

  container.innerHTML = sections
    .map(
      (s) => `
        <div class="rule-section">
          <h3>${highlight(s.heading)}</h3>
          <ul class="rule-list">${s.bullets.map((b) => `<li>${highlight(b)}</li>`).join("")}</ul>
        </div>
      `
    )
    .join("") || '<div class="empty-state">No matching rules.</div>';
}

/* ---------- Nav ---------- */

function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".page").forEach((p) => (p.hidden = true));
      $(`#page-${btn.dataset.page}`).hidden = false;
      if (btn.dataset.page === "h2h") loadAndRenderH2H();
      if (btn.dataset.page === "otd") loadAndRenderOnThisDay();
    });
  });
}

/* ---------- Bootstrap ---------- */

async function init() {
  try {
    setStatus("Loading league info…");
    const [league] = await Promise.all([loadLeagueShell(), loadPlayers()]);

    setStatus("Loading transactions, taxi log, and salary sheet…");
    const maxWeek = CFG.maxWeek || (league.settings && league.settings.leg) || 18;
    const currentWeek = Math.max(1, Math.min(maxWeek, (league.settings && league.settings.leg) || maxWeek));

    const [transactions, taxiEvents, sheetByRoster, statsData, standingsExtra] = await Promise.all([
      loadTransactions(maxWeek),
      loadTaxiLog(),
      SheetData.loadAll(CFG.googleSheetId, CFG.sheetTabsByRosterId, CFG.snapshotSheetName).catch((err) => {
        console.error("Sheet load failed:", err);
        return {};
      }),
      StatsData.loadSeasonPoints(league.season, currentWeek).catch((err) => {
        console.error("Stats load failed:", err);
        return { totals: new Map(), weekly: new Map() };
      }),
      loadStandingsExtras(currentWeek).catch((err) => {
        console.error("Standings extras (streak/Max PF) failed:", err);
        return { streakByRoster: new Map(), maxPFByRoster: new Map() };
      }),
    ]);

    state.sheetByRoster = sheetByRoster;
    state.pointsByPlayer = statsData.totals;
    state.weeklyPointsByPlayer = statsData.weekly;
    state.standingsExtra = standingsExtra;
    state.rawTransactions = transactions; // this season's deduped transactions (used by the activity feed)

    const liveEvents = transactionsToEvents(transactions);
    state.events = [...liveEvents, ...taxiEvents].sort((a, b) => (b.date || 0) - (a.date || 0));

    markSynced();
    setStatus(`Loaded ${state.events.length} events.`);

    applyFilters();
    renderStandings();
    renderCapMatrix();
    renderRostersPage();
    renderLeaderboards();
    initTradeMachine();
    renderRulesPage("");
    renderDraftPage();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load league data: ${err.message}`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initNav();
  init();

  $("#team-filter").addEventListener("change", applyFilters);
  document.querySelectorAll(".checkboxes input").forEach((c) => c.addEventListener("change", applyFilters));
  $("#search-box").addEventListener("input", () => {
    clearTimeout(window.__searchDebounce);
    window.__searchDebounce = setTimeout(applyFilters, 150);
  });
  $("#load-more-btn").addEventListener("click", renderMore);
  $("#refresh-btn").addEventListener("click", () => {
    localStorage.removeItem("sleeper_players_nfl_v1_ts");
    init();
  });
  $("#rules-search").addEventListener("input", (e) => renderRulesPage(e.target.value));
});
