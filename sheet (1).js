/* Google Sheet salary data layer.
 *
 * The league's salary cap ledger lives in a Google Sheet the commissioners
 * maintain by hand (Sleeper has no concept of "salary" at all). We read it
 * live via Google's gviz CSV export, which works for any sheet whose
 * sharing is set to "Anyone with the link can view" — no API key needed.
 *
 * Sheet shape (one tab per team, named after their Sleeper username, plus
 * a "Salary Cap Snapshot" tab with the leaguewide totals):
 *   Row: "", "Active Roster", ...
 *   Row: "", "Player", "Position", "", "", "", "", ...   (section header)
 *   Row: "1", "<name>", "<pos>", "$<salary>", "$<dropBefore7>", "$<dropAfter7>", "$<2027 keeper>", ...
 *   ...
 *   Row: "", "Total", "", "$<section salary total>", ...
 * repeated for "Active Roster", "Taxi Squad", and "IR" sections.
 */

const SheetData = (() => {
  const GVIZ_URL = (sheetId, tabName) =>
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
      tabName
    )}`;

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function money(s) {
    if (s === undefined || s === null) return 0;
    const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  async function fetchRows(sheetId, tabName) {
    // Cache-bust: Google's CSV export and/or the browser can otherwise
    // serve a stale copy of one tab indefinitely.
    const url = `${GVIZ_URL(sheetId, tabName)}&_=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Sheet tab "${tabName}" -> HTTP ${res.status}`);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error(`Sheet tab "${tabName}" returned empty`);
    return parseCSV(text);
  }

  function parseSnapshot(rows) {
    // Deliberately doesn't assume a fixed number of title/header rows —
    // the sheet's exact row layout has shifted before (a merged/deleted
    // row silently broke a hardcoded offset). Instead: any row whose first
    // cell is non-empty, isn't an obvious label, and whose second cell
    // looks like a dollar amount is treated as a team's data row.
    const byTeam = {};
    for (const r of rows) {
      const team = (r[0] || "").trim();
      if (!team) continue;
      if (/salary cap/i.test(team) || team.toLowerCase() === "team") continue;
      const salaryCell = (r[1] || "").trim();
      if (!/-?\$?\d/.test(salaryCell)) continue;
      byTeam[team] = {
        remainingCap: money(r[1]),
        deadCap: money(r[2]),
      };
    }
    return byTeam;
  }

  const DEAD_CAP_LABELS = new Set([
    "",
    "Dead Cap",
    "Dropped Players",
    "Player",
    'Salary "Eaten" By Other Teams',
    "Remaining Allowed",
    "Over the Cap Players",
    "Owner",
    "Salary",
  ]);

  function parseTeamSheet(rows) {
    const sections = { activeRoster: [], taxiSquad: [], ir: [] };
    const totals = { activeRosterSalary: 0, taxiSalary: 0, irSalary: 0 };
    const deadCapPlayers = [];
    let mode = null;

    for (const r of rows) {
      const c1 = (r[1] || "").trim();

      // The dead-cap "Dropped Players" mini-table lives beside the active
      // roster table in columns 8-11 on whichever rows it happens to share
      // visually with — independent of which section (mode) we're in.
      const c8 = (r[8] || "").trim();
      if (c8 && !DEAD_CAP_LABELS.has(c8) && /\$?-?[\d.]+/.test(r[9] || "")) {
        deadCapPlayers.push({
          name: c8.replace(/\s*\(eating \$\d+\)\s*/i, "").trim(),
          salary: money(r[9]),
        });
      }

      if (c1 === "Active Roster") {
        mode = "activeRoster";
        continue;
      }
      if (c1 === "Taxi Squad") {
        mode = "taxiSquad";
        continue;
      }
      if (c1 === "IR") {
        mode = "ir";
        continue;
      }
      if (c1 === "Player") continue; // section header row
      if (c1 === "Total") {
        if (mode === "activeRoster") totals.activeRosterSalary = money(r[3]);
        if (mode === "taxiSquad") totals.taxiSalary = money(r[3]);
        if (mode === "ir") totals.irSalary = money(r[3]);
        mode = null;
        continue;
      }
      if (!mode) continue;

      const name = (r[1] || "").trim();
      if (!name || name === "EMPTY") continue;

      sections[mode].push({
        name,
        pos: (r[2] || "").trim(),
        salary: money(r[3]),
        dropBefore7: money(r[4]),
        dropAfter7: money(r[5]),
        keeper2027: money(r[6]),
      });
    }

    return { ...sections, totals, deadCapPlayers };
  }

  function normalizeName(n) {
    return (n || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[.'\-]/g, "")
      .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Loads the snapshot tab plus every team tab, and returns a combined
   * per-roster-id view: { [rosterId]: { activeRoster, taxiSquad, ir, cap } }
   */
  async function loadAll(sheetId, sheetTabsByRosterId, snapshotTabName) {
    const rosterIds = Object.keys(sheetTabsByRosterId);

    const snapshotRows = await fetchRows(sheetId, snapshotTabName);
    const teamResults = await Promise.allSettled(
      rosterIds.map((rid) => fetchRows(sheetId, sheetTabsByRosterId[rid]))
    );

    const snapshot = parseSnapshot(snapshotRows);
    const byRoster = {};

    rosterIds.forEach((rid, idx) => {
      const tabName = sheetTabsByRosterId[rid];
      const result = teamResults[idx];
      if (result.status === "rejected") {
        console.error(`Sheet tab "${tabName}" (roster ${rid}) failed to load:`, result.reason);
      }
      const parsed = result.status === "fulfilled"
        ? parseTeamSheet(result.value)
        : { activeRoster: [], taxiSquad: [], ir: [], deadCapPlayers: [], totals: { activeRosterSalary: 0, taxiSalary: 0, irSalary: 0 }, loadFailed: true };
      const snap = snapshot[tabName] || { remainingCap: 0, deadCap: 0 };
      byRoster[rid] = {
        ...parsed,
        cap: {
          activeSalary: parsed.totals.activeRosterSalary,
          irSalary: parsed.totals.irSalary,
          taxiSalary: parsed.totals.taxiSalary,
          deadCap: snap.deadCap,
          remainingCap: snap.remainingCap,
        },
      };
    });

    return byRoster;
  }

  return { loadAll, normalizeName, money };
})();
