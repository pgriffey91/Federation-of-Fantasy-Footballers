/* Full league rulebook content, embedded so the Rule Book page can search
 * it client-side with no network call. Kept close to verbatim from the
 * league's rule book doc; lightly cleaned up for display. */

const RULEBOOK_SECTIONS = [
  {
    heading: "League Overview",
    bullets: [
      "League type: Hard Salary Cap Dynasty.",
      "League host: Sleeper (startup auction was on Yahoo).",
      "Commissioner: Dave Purcell. Co-Commissioners: Pat Griffin & Joe Froelich.",
      "The commissioner and co-commissioners can rule on anything not explicitly covered here; a 2/3 majority among the three is final.",
      "Dues are $50/year (cash, check, or Venmo). Every year after the first, payment is due by 11:59 PM CST on the second Sunday after the Super Bowl.",
      "If an owner hasn't paid by February 1st, their team is deemed abandoned and a new owner is found.",
      "Trades for picks can be made up to two years into the future; unpaid future-year fees must be settled or the trade isn't approved. Commissioner approval is required for all trades.",
      "Payouts: Playoff Champion $350, Playoff 2nd place $100, Regular season Points-For Champion $50.",
    ],
  },
  {
    heading: "Team Rosters",
    bullets: [
      "Active rosters may not exceed 26 players at any time: 9 starting spots + 15 bench spots. IR and taxi squad players don't count toward this limit.",
      "No positional minimum. Active roster may have no more than 5 QBs.",
    ],
  },
  {
    heading: "Starting Lineup",
    bullets: [
      "Lineups lock per player at that player's individual game start.",
      "9 starting spots: 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX, 1 SUPERFLEX (QB/RB/WR/TE).",
    ],
  },
  {
    heading: "Scoring",
    bullets: ["Sleeper standard scoring, .5 PPR."],
  },
  {
    heading: "Schedule",
    bullets: ["Determined randomly before each season."],
  },
  {
    heading: "Playoffs",
    bullets: [
      "6-team playoff bracket, no reseeding.",
      "Top 4 seeds by overall record; ties broken by total points for, then head-to-head, then points against, then a coin flip.",
      "5th and 6th seeds go to the highest Points-For among the remaining teams.",
      "1st and 2nd seed get a first-round bye.",
      "Playoff ties are broken by bench points, then taxi squad points, then the higher seed advances.",
      "Playoff weeks: Round 1 = Week 15, Semifinals = Week 16, Championship = Week 17.",
    ],
  },
  {
    heading: "Startup Draft (Year 1 only)",
    bullets: [
      "Auction-style draft. The highest bid wins the player, and that bid becomes the player's salary for the year.",
      "$400 budget for the auction draft.",
    ],
  },
  {
    heading: "In-Season Free Agency",
    bullets: [
      "FAAB-style bidding. After the startup draft (Year 1 only), $100 FAAB is added, making the hard cap $500.",
      "Waiver wire closes Week 16 and reopens during the league's free-agency period.",
      "Minimum bid is $1; the highest bid wins and becomes the player's salary for the season.",
      "If a team drops a player, they must wait one full waiver cycle before re-adding a player, to stop teams from dropping high-salary players and re-signing them cheaper.",
      "If a team has no cap space left, they can sign players for $0. If cap space later frees up, a $0 salary becomes $1. Season-to-season, $0 players transition as if they were $1 players.",
      "Waivers clear Thursday, Saturday, and Sunday of each regular-season week (time TBD).",
    ],
  },
  {
    heading: "Off-Season Free Agency",
    bullets: [
      "An auction draft run through a Google Sheet, date TBD in August.",
      "Timing between a bid and the player being awarded is set before the first free agency of the league.",
      "The commissioner sets a date that works for the whole league where possible; an owner who can't make it is responsible for finding a fill-in.",
    ],
  },
  {
    heading: "Rookie Draft",
    bullets: [
      "Held within one month of the NFL draft, before the league's free agency period. 4 rounds, linear (non-snake), run through a Google Sheet.",
      "Draft order for non-playoff teams is set by each team's weekly \"optimal lineup\" potential points (top QB, top 2 RB, top 2 WR, top TE, 2 top flex-eligible, top SuperFlex-eligible).",
      "Playoff finishers draft in inverse order of finish: Champion picks 10th, 2nd place 9th, 3rd place 8th, 4th place 7th, 5th place 5th, 6th place 6th.",
      "Rookie Salary Schedule — Round 1: Pick 1 = $30; Picks 2-3 = $26; Picks 4-6 = $23; Picks 7-10 = $20. Round 2: Picks 1-3 = $15; Picks 4-7 = $12; Picks 8-10 = $9. Round 3: Picks 1-5 = $6; Picks 6-10 = $5. Round 4: all picks = $2.",
    ],
  },
  {
    heading: "Salary Rules",
    bullets: [
      "$500 hard cap (Year 1: $400 for the startup draft, +$100 added for in-season free agency).",
      "Dropping a player before Week 7 of the regular season gives 75% cap relief (rounded down); dropping after Week 7 gives 50% cap relief (rounded down). Example: a $10 salary player dropped before Week 7 frees $7 in cap space; after Week 7 frees $5.",
      "After the season ends, all dead cap resets. No salary is guaranteed past one season.",
      "Keeper salary increases are tiered by previous salary: $1-5 -> +100%, $6-10 -> +75%, $11-15 -> +50%, $16-20 -> +25%, $21-30 -> +15%, $31-45 -> +12.5%, $46-60 -> +10%, >$60 -> +7.5%.",
      "Every team must be cap-compliant at all times from 7 days after the Rookie Draft through the Super Bowl. If over the cap, that team's lineup is locked until they get compliant, with escalating commissioner penalties for repeated weeks over.",
      "In the offseason window (between that 7-day mark and the Monday before Week 1), a team has 3 days to get under the cap before escalating penalties kick in (renewing every 3 days).",
    ],
  },
  {
    heading: "Keeping Players",
    bullets: [
      "A full list of kept players must be submitted via Google Sheets within 7 days of the Rookie Draft's conclusion.",
      "Any player not listed is dropped to free agency upon submission.",
      "There's no minimum or maximum number of players you must keep.",
    ],
  },
  {
    heading: "Trading",
    bullets: [
      "All trades are approved unless the commissioner panel rules it collusion, or it leaves a team salary-cap non-compliant.",
      "All draft picks and players are tradable. Trading a future pick requires both owners to be paid through the pick's season(s).",
      "No trades between Week 13 and the opening of the new league year.",
      "Trades are final once submitted and accepted by all teams through Sleeper.",
      "You can receive up to $50 of cap space (retained salary) per year via trade.",
      "A team can \"eat\" salary when trading a player away: e.g., Team A trades a $60-salary player to Team B and eats $50 of it — Team B is only responsible for $10 this season. Next season, Team B assumes the full salary.",
    ],
  },
  {
    heading: "Injured Reserve",
    bullets: [
      "3 IR spots per team. A player must be on the NFL's official IR list to be placed on your IR, and must return to your active roster upon NFL reinstatement.",
      "Each team can also place 1 player on Season-Ending IR, which returns 50% of their salary. This designation can't be changed even if a higher-salary player later gets hurt, and that player can't return to play that season.",
    ],
  },
  {
    heading: "Taxi Squad",
    bullets: [
      "5 taxi squad spots. Rookies and 2nd-year players are taxi-eligible.",
      "Taxi squad salary does not count against the hard cap.",
      "Once called up from the taxi squad, a player can never return to it, and their full salary counts against the cap from then on — including if they're traded while active, which permanently ends their taxi eligibility.",
    ],
  },
  {
    heading: "Rule & Format Changes",
    bullets: [
      "Rule/format changes can be proposed after each season via email, text to the commissioner panel, or the league group chat.",
      "Changes affecting roster construction have a mandatory one-season delay, unless passed within one week of the Super Bowl or the proposal gets 8+ of 10 votes for immediate change.",
      "A proposal needs 2 of 3 commissioner-panel votes before going to a full league vote, and 6 of 10 league votes to pass.",
    ],
  },
  {
    heading: "Owners Leaving the League",
    bullets: [
      "An owner may retire \"in good standing\" between Week 16 and the League Reset date; they're prevented from making transactions once announced, and may rejoin if a future vacancy opens.",
      "A refund for leaving in good standing is at the commissioner panel's discretion (roster state, difficulty replacing the owner); if any future picks were traded away, no refund is given automatically.",
      "An owner who leaves under any other condition (a ban) can't rejoin and gets no refund for the prepaid season.",
    ],
  },
  {
    heading: "Banning",
    bullets: [
      "The commissioner panel can ban an owner for life for reasons including roster mismanagement that affects league outcomes, collusion, or other conduct that hurts the league's enjoyment.",
      "A banned owner's roster is locked and they're immediately out of the league.",
    ],
  },
  {
    heading: "Replacing Owners",
    bullets: [
      "The commissioner fills vacancies by whatever means keeps the league stable — friends/family first, then r/findaleague and r/dynastyff with a vote among league members.",
      "If multiple franchises are vacant at once, a supplemental draft pools all vacant rosters' players and picks with free agents, and new owners draft from that pool in randomly assigned snake order.",
    ],
  },
];
