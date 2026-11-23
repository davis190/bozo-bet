/** What each stat means, in one place: stat tiles, the leaderboard and the Stats glossary all read from here. */
export interface Term {
  term: string;
  def: string;
}

export const GLOSSARY = {
  parlaysHit: { term: "Parlays hit", def: "How many group parlays cashed. “Odds said” is the hit rate the leg odds predicted on average." },
  curseMeter: { term: "Curse meter", def: "Actual parlay hit rate minus what the odds predicted. Below zero = cursed; above = blessed." },
  oneLegAway: { term: "One leg away", def: "Parlays that died to exactly one losing leg (that player was auto-bozo)." },
  groupPnl: { term: "Group P&L", def: "Everything the casino paid out on hits minus every wager the bozos have put in." },
  record: { term: "Record", def: "Wins-losses-pushes on your legs. Pushes don't count toward win %." },
  winPct: { term: "Win %", def: "Wins ÷ (wins + losses). “Odds said” is the win % your odds predicted: the average implied chance of your picks hitting." },
  luck: { term: "Luck", def: "Actual wins minus the wins your odds predicted. Ten -110 legs are ~52% each, so they “should” win about 5.2. Positive = running hot; negative = the universe hates you." },
  units: { term: "Flat-bet units", def: "Profit if every leg were its own $1 straight bet at its odds. Parlay luck cancels out, so this is the closest thing to a skill score. Positive = your picks alone would make money." },
  avgOdds: { term: "Avg odds", def: "The typical price of your legs (payouts averaged, then turned back into American odds). Big negative = chalk merchant; plus money = long shots. “Best” is your longest-odds winner." },
  streak: { term: "Streak", def: "Your current run of straight wins (W) or losses (L). Pushes are skipped." },
  lastBozo: { term: "Last bozo", def: "How long since you last had to go to the casino, in bets and in days." },
  timesBozo: { term: "Times bozo", def: "Bets you placed as the bozo. Voted = the group picked you; solo = your leg was the only loser; reload = self-proclaimed after an early loss." },
  bozoCurse: { term: "Bozo curse", def: "Your own leg's record on the weeks you were the bozo. Does carrying the slip jinx you?" },
  soleAssassins: { term: "Sole Assassins", def: "Every time a parlay died to exactly one leg, with everyone else cashing. The killer is auto-bozo, and the money is what that parlay would have paid." },
  soleAssassin: { term: "Sole assassin", def: "Parlays where yours was the only losing leg: everyone else hit. “Left on the table” adds up what those parlays would have paid." },
  net: { term: "Net $", def: "Your share of winning parlays minus what you've paid in wagers as the bozo." },
  homer: { term: "Homer index", def: "Your record on legs backing your favorite teams (set them in Settings)." },
  traitor: { term: "Traitor index", def: "Your record when betting against your own favorite teams." },
  badBeat: { term: "Bad beat index", def: "On losing legs with a line, the average amount you missed by (points, yards, TDs…). Small = heartbreak; big = never close." },
  approval: { term: "Group approval", def: "Share of 👍 vs 👎 Slack reactions on your leg posts. Mystery emojis (🤷) don't count until the admin decides what they mean." },
  bozos: { term: "🤡 (leaderboard)", def: "Times bozo: how many bets you've had to place." },
} satisfies Record<string, Term>;

export type TermKey = keyof typeof GLOSSARY;
