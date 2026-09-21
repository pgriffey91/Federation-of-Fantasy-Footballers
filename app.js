/* League Activity Feed
 * Pulls live add/drop/trade data from the Sleeper API and merges it with a
 * taxi-squad move log that a scheduled GitHub Action maintains in
 * data/taxi-log.json (Sleeper's API has no history endpoint for taxi moves).
 */

const CFG = window.LEAGUE_CONFIG;
const API = "https://api.sleeper.app/v1";
const PAGE_SIZE = 40;

const state = {
  rosterMap: new Map(),   // roster_id -> { name, teamName, avatar, ownerId }
  players: new Map(),     // player_id -> { name, pos, team }
  events: [],             // all normalized events, sorted newest first
  filtered: [],
  shown: 0,
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
    // localStorage full or unavailable — fall through to network fetch
  }

  setStatus("Downloading player database from Sleeper (first load only, then cached)…");
  const data = await fetchJSON(`${API}/players/nfl`);
  applyPlayers(data);

  try {
    localStorage.setItem(cacheKey, JSON.stringify(data));
    localStorage.setItem(cacheTsKey, String(Date.now()));
  } catch (e) {
    // Player DB is large; if storage quota is exceeded just skip caching.
  }
}

function applyPlayers(data) {
  state.players.clear();
  for (const [id, p] of Object.entries(data)) {
    if (!p) continue;
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || `Player ${id}`;
    state.players.set(id, { name, pos: p.position || "", team: p.team || "FA" });
  }
}

function playerLabel(id) {
  const p = state.players.get(String(id));
  if (!p) return `Player #${id}`;
  return p.pos ? `${p.name} (${p.pos})` : p.name;
}

/* ---------- League / rosters / users ---------- */

async function loadLeagueShell() {
  const [league, users, rosters] = await Promise.all([
    fetchJSON(`${API}/league/${CFG.leagueId}`),
    fetchJSON(`${API}/league/${CFG.leagueId}/users`),
    fetchJSON(`${API}/league/${CFG.leagueId}/rosters`),
  ]);

  const userMap = new Map(users.map((u) => [u.user_id, u]));

  state.rosterMap.clear();
  for (const r of rosters) {
    const u = userMap.get(r.owner_id) || {};
    const teamName = (u.metadata && u.metadata.team_name) || u.display_name || `Roster ${r.roster_id}`;
    state.rosterMap.set(r.roster_id, {
      name: teamName,
      ownerDisplay: u.display_name || teamName,
      avatar: u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null,
      ownerId: r.owner_id,
    });
  }

  $("#site-title").textContent = CFG.siteName || league.name || "League Activity Feed";
  $("#season-label").textContent = league.season ? `${league.season} season` : "";
  document.title = CFG.siteName || league.name || "League Activity Feed";

  populateTeamFilter();
  return league;
}

function populateTeamFilter() {
  const select = $("#team-filter");
  const existing = new Set(Array.from(select.options).map((o) => o.value));
  const teams = Array.from(state.rosterMap.entries())
    .map(([id, r]) => ({ id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const t of teams) {
    const key = String(t.id);
    if (existing.has(key)) continue;
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
}

function teamName(rosterId) {
  const r = state.rosterMap.get(rosterId) || state.rosterMap.get(Number(rosterId));
  return r ? r.name : `Roster ${rosterId}`;
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
    setStatus(`Loading transactions… week ${Math.min(i + CONCURRENCY, weeks.length)} / ${weeks.length}`);
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

function transactionsToEvents(transactions) {
  const events = [];

  for (const tx of transactions) {
    const created = tx.status_updated || tx.created;

    if (tx.type === "trade") {
      events.push(...tradeToEvents(tx, created));
      continue;
    }

    // waiver / free_agent / commissioner add-drop moves
    const bid = tx.settings && typeof tx.settings.waiver_bid === "number" ? tx.settings.waiver_bid : null;
    const rosterIds = tx.roster_ids && tx.roster_ids.length ? tx.roster_ids : Object.values(tx.adds || {}).concat(Object.values(tx.drops || {}));

    // Adds
    if (tx.adds) {
      for (const [playerId, rosterId] of Object.entries(tx.adds)) {
        events.push({
          id: `${tx.transaction_id}-add-${playerId}`,
          type: "add",
          date: created,
          rosterIds: [rosterId],
          playerIds: [playerId],
          amount: bid,
          txType: tx.type,
        });
      }
    }
    // Drops
    if (tx.drops) {
      for (const [playerId, rosterId] of Object.entries(tx.drops)) {
        events.push({
          id: `${tx.transaction_id}-drop-${playerId}`,
          type: "drop",
          date: created,
          rosterIds: [rosterId],
          playerIds: [playerId],
          amount: null,
          txType: tx.type,
        });
      }
    }
  }

  return events;
}

function tradeToEvents(tx, created) {
  const adds = tx.adds || {};
  const drops = tx.drops || {};
  const picks = tx.draft_picks || [];
  const rosterIds = tx.roster_ids || [];

  const gains = new Map(); // rosterId -> { players: [], picks: [] }
  for (const id of rosterIds) gains.set(id, { players: [], picks: [] });

  for (const [playerId, rosterId] of Object.entries(adds)) {
    if (!gains.has(rosterId)) gains.set(rosterId, { players: [], picks: [] });
    gains.get(rosterId).players.push(playerId);
  }
  for (const pick of picks) {
    const toRoster = pick.owner_id;
    if (!gains.has(toRoster)) gains.set(toRoster, { players: [], picks: [] });
    gains.get(toRoster).picks.push(pick);
  }

  return [
    {
      id: `${tx.transaction_id}-trade`,
      type: "trade",
      date: created,
      rosterIds,
      gains: Array.from(gains.entries()),
      txType: "trade",
    },
  ];
}

function pickLabel(pick) {
  const round = pick.round;
  const suffix = round === 1 ? "st" : round === 2 ? "nd" : round === 3 ? "rd" : "th";
  const originalTeam = teamName(pick.roster_id);
  return `${pick.season} ${round}${suffix}-round pick (${originalTeam}'s)`;
}

/* ---------- Taxi log (from GitHub-Action-maintained JSON) ---------- */

async function loadTaxiLog() {
  try {
    const log = await fetchJSON(`data/taxi-log.json?_=${Date.now()}`);
    return (Array.isArray(log) ? log : []).map((e) => ({
      id: e.id,
      type: e.type, // "taxi_add" | "taxi_remove"
      date: e.date,
      rosterIds: [e.roster_id],
      playerIds: [e.player_id],
      amount: null,
      txType: "taxi",
    }));
  } catch (e) {
    console.warn("No taxi log available yet:", e);
    return [];
  }
}

/* ---------- Rendering ---------- */

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function eventMatchesFilters(ev, { teamId, types, query }) {
  if (types.size && !types.has(ev.type)) return false;

  if (teamId) {
    const involved = ev.rosterIds.map(String);
    if (!involved.includes(teamId)) return false;
  }

  if (query) {
    const q = query.toLowerCase();
    const names = (ev.playerIds || []).map((id) => playerLabel(id).toLowerCase());
    if (ev.type === "trade") {
      const gainNames = ev.gains.flatMap(([, g]) =>
        g.players.map((p) => playerLabel(p).toLowerCase())
      );
      if (!gainNames.some((n) => n.includes(q))) return false;
    } else if (!names.some((n) => n.includes(q))) {
      return false;
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
      .filter(([, g]) => g.players.length || g.picks.length)
      .map(([rosterId, g]) => {
        const items = [
          ...g.players.map((p) => playerLabel(p)),
          ...g.picks.map((p) => pickLabel(p)),
        ];
        return `<span class="team">${teamName(rosterId)}</span> gets ${items.join(", ")}`;
      });
    title.innerHTML =
      `<span class="tag trade">Trade</span> ${teams.join(" ⇄ ")}<br>` + parts.join("<br>");
  } else if (ev.type === "add") {
    const amountHtml =
      ev.amount !== null ? ` for <span class="amount">$${ev.amount}</span>` : "";
    title.innerHTML = `<span class="tag add">Add</span> <span class="team">${teamName(
      ev.rosterIds[0]
    )}</span> added ${playerLabel(ev.playerIds[0])}${amountHtml}`;
  } else if (ev.type === "drop") {
    title.innerHTML = `<span class="tag drop">Drop</span> <span class="team">${teamName(
      ev.rosterIds[0]
    )}</span> dropped ${playerLabel(ev.playerIds[0])}`;
  } else if (ev.type === "taxi_add") {
    title.innerHTML = `<span class="tag taxi_add">Taxi</span> <span class="team">${teamName(
      ev.rosterIds[0]
    )}</span> moved ${playerLabel(ev.playerIds[0])} onto the taxi squad`;
  } else if (ev.type === "taxi_remove") {
    title.innerHTML = `<span class="tag taxi_remove">Taxi</span> <span class="team">${teamName(
      ev.rosterIds[0]
    )}</span> moved ${playerLabel(ev.playerIds[0])} off the taxi squad`;
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
  const types = new Set(
    Array.from(document.querySelectorAll(".checkboxes input:checked")).map((c) => c.value)
  );
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

/* ---------- Bootstrap ---------- */

async function init() {
  try {
    setStatus("Loading league info…");
    const [league] = await Promise.all([loadLeagueShell(), loadPlayers()]);

    setStatus("Loading transactions…");
    const maxWeek = CFG.maxWeek || (league.settings && league.settings.leg) || 18;
    const [transactions, taxiEvents] = await Promise.all([
      loadTransactions(maxWeek),
      loadTaxiLog(),
    ]);

    const liveEvents = transactionsToEvents(transactions);
    state.events = [...liveEvents, ...taxiEvents].sort((a, b) => (b.date || 0) - (a.date || 0));

    setStatus(`Loaded ${state.events.length} events.`);
    applyFilters();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load league data: ${err.message}`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init();

  $("#team-filter").addEventListener("change", applyFilters);
  document
    .querySelectorAll(".checkboxes input")
    .forEach((c) => c.addEventListener("change", applyFilters));
  $("#search-box").addEventListener("input", () => {
    clearTimeout(window.__searchDebounce);
    window.__searchDebounce = setTimeout(applyFilters, 150);
  });
  $("#load-more-btn").addEventListener("click", renderMore);
  $("#refresh-btn").addEventListener("click", () => {
    localStorage.removeItem("sleeper_players_nfl_v1_ts");
    init();
  });
});
