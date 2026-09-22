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
  trade: { teamA: null, teamB: null, retained: {} }, // retained: { "A:PlayerName": $, "B:PlayerName": $ }
  rosterPositions: [], // league's starting-lineup slot list (e.g. ["QB","RB","RB","WR","WR","TE","FLEX","DEF","K","BN",...])
  standingsExtra: { streakByRoster: new Map(), maxPFByRoster: new Map() },
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

function playerIdForName(name) {
  return state.nameIndex.get(SheetData.normalizeName(name));
}

/* ---------- League / rosters / users ---------- */

async function loadLeagueShell() {
  const [league, users, rosters] = await Promise.all([
    fetchJSON(`${API}/league/${CFG.leagueId}`),
    fetchJSON(`${API}/league/${CFG.leagueId}/users`),
    fetchJSON(`${API}/league/${CFG.leagueId}/rosters`),
  ]);

  state.league = league;
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
  renderHeaderStats(league);
  return league;
}

function populateTeamFilter() {
  const teams = Array.from(state.rosterMap.entries())
    .map(([id, r]) => ({ id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const select of [$("#team-filter"), $("#myteam-select")]) {
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

function renderHeaderStats(league) {
  $("#stat-cap").textContent = `$${CFG.hardCap}`;

  const deadline = league.settings && league.settings.trade_deadline;
  $("#stat-deadline").textContent = deadline ? `Week ${deadline}` : "—";

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
    .sort((a, b) => b.cap.remainingCap - a.cap.remainingCap);

  if (!cards.length) {
    container.innerHTML = '<div class="empty-state">Salary data not available — check the Google Sheet is shared as "Anyone with the link".</div>';
    return;
  }

  container.innerHTML = cards.map(({ rid }) => buildCapCardHTML(rid)).join("");
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

// Seed 1 = 1st-round bye, seed 2 = 2nd-round bye, 3-4 = playoffs, 5-6 =
// wild card (still seeded by points among the non-top-4 teams), 7-10 show
// how many points they're back of 6th place (points scored) instead of a
// plain label.
function rankMeta(seed, ranked) {
  if (seed === 1) return { label: "1st Bye", cls: "rk-bye" };
  if (seed === 2) return { label: "2nd Bye", cls: "rk-bye" };
  if (seed <= 4) return { label: "Playoffs", cls: "rk-playoff" };
  if (seed <= 6) return { label: "Points WC", cls: "rk-wildcard" };
  const sixth = ranked[5];
  const gap = sixth ? Math.max(0, sixth.pointsFor - ranked[seed - 1].pointsFor) : 0;
  return { label: `${gap.toFixed(1)} back`, cls: "rk-out" };
}

function streakClass(streak) {
  if (streak.startsWith("W")) return "streak-win";
  if (streak.startsWith("L")) return "streak-loss";
  if (streak.startsWith("T")) return "streak-tie";
  return "";
}

function renderStandings() {
  const container = $("#standings");
  if (!container) return;

  const rosterIds = Array.from(state.rosterMap.keys());
  if (!rosterIds.length) {
    container.innerHTML = '<div class="empty-state">Standings not available.</div>';
    return;
  }

  const teams = rosterIds.map((rid) => ({ rid, ...state.rosterMap.get(rid) }));

  // Seeds 1-4: sorted by record (wins desc, then losses asc, then points
  // scored as the tiebreaker). Seeds 5-10: sorted purely by points scored,
  // regardless of record, per league convention.
  const byRecord = [...teams].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return b.pointsFor - a.pointsFor;
  });
  const top4 = byRecord.slice(0, 4);
  const top4Ids = new Set(top4.map((t) => t.rid));
  const rest = teams.filter((t) => !top4Ids.has(t.rid)).sort((a, b) => b.pointsFor - a.pointsFor);

  const ranked = [...top4, ...rest];
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

/* ---------- My Team / League Rosters ---------- */

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

function renderMyTeamPage() {
  const select = $("#myteam-select");
  const body = $("#myteam-body");
  const render = () => {
    const rid = select.value;
    const sheet = state.sheetByRoster[rid];
    if (!sheet) {
      body.innerHTML = '<div class="empty-state">No salary data for this team.</div>';
      return;
    }
    const cap = sheet.cap;
    body.innerHTML = `
      <div class="team-cap-summary">
        <span><strong>${money(cap.activeSalary + cap.irSalary)}</strong> active salary</span>
        <span><strong>${money(cap.deadCap)}</strong> dead cap</span>
        <span><strong>${money(cap.remainingCap)}</strong> remaining</span>
        <span><strong>${money(cap.taxiSalary)}</strong> on taxi (not counted)</span>
      </div>
      ${rosterTableHTML(sheet)}
    `;
  };
  select.addEventListener("change", render);
  if (select.options.length) render();
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

function leaderboardRowHTML(rank, primary, secondary, valueLabel) {
  return `
    <div class="lb-row">
      <span class="lb-rank">${rank}</span>
      <span class="lb-main">
        <span class="lb-player">${primary}</span>
        <span class="lb-sub">${secondary}</span>
      </span>
      <span class="lb-value">${valueLabel}</span>
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
        `${p.value.toFixed(2)} pts/$`
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

/* ---------- Draft & FA page ---------- */

const ROOKIE_SCHEDULE = [
  ["1.01", "$30"], ["1.02–1.03", "$26"], ["1.04–1.06", "$23"], ["1.07–1.10", "$20"],
  ["2.01–2.03", "$15"], ["2.04–2.07", "$12"], ["2.08–2.10", "$9"],
  ["3.01–3.05", "$6"], ["3.06–3.10", "$5"],
  ["Round 4 (all picks)", "$2"],
];

function renderDraftPage() {
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

    const [transactions, taxiEvents, sheetByRoster, pointsByPlayer, standingsExtra] = await Promise.all([
      loadTransactions(maxWeek),
      loadTaxiLog(),
      SheetData.loadAll(CFG.googleSheetId, CFG.sheetTabsByRosterId, CFG.snapshotSheetName).catch((err) => {
        console.error("Sheet load failed:", err);
        return {};
      }),
      StatsData.loadSeasonPoints(league.season, currentWeek).catch((err) => {
        console.error("Stats load failed:", err);
        return new Map();
      }),
      loadStandingsExtras(currentWeek).catch((err) => {
        console.error("Standings extras (streak/Max PF) failed:", err);
        return { streakByRoster: new Map(), maxPFByRoster: new Map() };
      }),
    ]);

    state.sheetByRoster = sheetByRoster;
    state.pointsByPlayer = pointsByPlayer;
    state.standingsExtra = standingsExtra;

    const liveEvents = transactionsToEvents(transactions);
    state.events = [...liveEvents, ...taxiEvents].sort((a, b) => (b.date || 0) - (a.date || 0));

    markSynced();
    setStatus(`Loaded ${state.events.length} events.`);

    applyFilters();
    renderStandings();
    renderCapMatrix();
    renderMyTeamPage();
    renderRostersPage();
    renderLeaderboards();
    initTradeMachine();
    renderDraftPage();
    renderRulesPage("");
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
