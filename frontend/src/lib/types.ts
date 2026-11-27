export type Role = "public" | "none" | "viewer" | "player" | "admin";
export type Result = "W" | "L" | "P";
export type LiveStatus = "PENDING" | "ON_PACE" | "WON" | "IN_DOUBT" | "OFF_PACE" | "LOST" | "PUSH" | "UNKNOWN" | "EARLY";

export interface Player {
  id: string;
  slot: number;
  color: string;
  avatar?: string;
  pseudonym?: string;
  active?: boolean;
  displayName: string;
  name?: string;
  favoriteTeams?: { league: string; team: string }[];
  roastLevel?: "mild" | "spicy" | "no mercy";
  taunt?: string;
  slackNames?: string[];
  bannedWords?: string[];
  scouting?: Scouting;
}

export interface ScoutPick {
  id: string;
  label: string;
  why: string;
  recent: RecordOut;
  allTime: RecordOut;
}

/** Sarcastic "what to bet next", rebuilt after every settled bet from the last 20 legs. */
export interface Scouting {
  headline: string;
  take: string;
  confidence: "lock it in" | "lean" | "coin flip" | "pray";
  nothingTrending: boolean;
  ride?: ScoutPick;
  fade?: ScoutPick;
  window: RecordOut & { n: number };
  generatedAt: string;
  throughBet?: string;
}

export interface Leg {
  playerId: string;
  text: string;
  odds?: number;
  /** Where the odds came from when nobody typed them: the slip, the market's main line, or an alt-line estimate. */
  oddsSource?: "slip" | "market" | "estimate";
  sgp?: boolean;
  sgpOdds?: number;
  result?: Result;
  source?: string;
  carriedOver?: boolean;
  submittedAt?: string;
  parsed?: { sport?: string; market?: string; subject?: string; teams?: string[]; player?: string; stat?: string; line?: number };
  live?: { status: LiveStatus; detail?: string; progress?: number | null; updatedAt?: string; state?: "pre" | "in" | "post"; needsReview?: boolean };
  resultSource?: string;
  enrichment?: Record<string, unknown>;
  crowd?: Crowd;
}

/** The group's emoji verdict on a leg's Slack post. emojis: [name, count, kind] */
export interface Crowd {
  up: number; down: number; neutral: number; unknown: number;
  emojis: [string, number, "up" | "down" | "neutral" | "unknown"][];
}

export interface Voting {
  voters: string[];
  voted: string[];
  myVote?: string | null;
  revealed: boolean;
  votes?: { voterId: string; candidateId: string }[];
  tally?: Record<string, number>;
}

export type BetStatus = "OPEN" | "LOCKED" | "VOTING" | "CLOSED";

export interface Bet {
  id: string;
  date: string;
  kind: "bozo" | "side";
  title?: string;
  status: BetStatus;
  wager?: number;
  bettingFloor?: number;
  bozoId?: string;
  totalOdds?: number;
  computedOdds?: number;
  toWin?: number;
  payout?: number;
  perPerson?: number;
  result?: Result;
  outcome?: "hit" | "single" | "vote" | "reload" | "miss" | "kept";
  record?: string;
  nextBozoId?: string;
  nextBozoMethod?: "voted" | "auto" | "reload" | "stays" | "kept";
  candidates?: string[];
  tie?: string[];
  reloadOf?: string;
  reloadedInto?: string;
  hasSlip?: boolean;
  slipUrl?: string;
  legs: Leg[];
  sgpGroups?: { playerIds: string[]; odds: number }[];
  /** Side bet: counts for stats, but a miss keeps the current bozo instead of going to a vote. */
  noVote?: boolean;
  voting?: Voting;
  ballot?: BallotEntry[];
  tracker?: { runs: number; lastRun?: string; nextRun?: string | null; why?: string };
}

export interface BallotEntry {
  playerId: string;
  label: string;
  text?: string;
  odds?: number;
  headline?: string;
  take?: string;
}

export interface Current {
  currentBozoId?: string;
  bet: Bet | null;
  lastBet: Bet | null;
  sideBets: Bet[];
  players: Player[];
  droughts: Record<string, Drought>;
  settings: { defaultWager: number };
}

export interface Drought {
  lastDate: string;
  betsSince: number;
  daysSince: number;
  how?: "voted" | "auto" | "reload" | "stays";
}

export interface User {
  sub: string;
  email: string;
  name: string;
  role: Role;
  playerId?: string;
}

export interface RecordOut {
  w: number; l: number; p: number;
  pct: number | null; xPct: number | null; luck: number | null; units: number;
}

export interface PlayerStats extends RecordOut {
  playerId: string;
  bets: number; // bets they had a leg in
  avgOdds: number | null;
  avgWinOdds: number | null;
  bestWin: number | null;
  bozoCount: number;
  votedBozo: number; autoBozo: number; reloadBozo: number;
  spent: number; won: number; net: number;
  bozoCurse: RecordOut;
  soleKiller: number;
  soleKills: { betId: string; date: string; text?: string; odds?: number | null; toWin?: number | null; record?: string }[];
  leftOnTable: number;
  badBeatIndex: number | null;
  streaks: { current: string | null; longestW: number; longestL: number };
  recent: Result[];
  splits: Record<string, Record<string, RecordOut>>;
  topTeams: [string, number][];
  homer: RecordOut;
  againstTeam: RecordOut;
  crowd: { up: number; down: number; neutral: number; unknown: number };
}

export interface Stats {
  range?: { from?: string | null; to?: string | null; kind: "bozo" | "side" };
  group: {
    parlays: number; hits: number; hitRate: number | null; expectedHitRate: number | null;
    nearMisses: number; spent: number; paidOut: number;
    biggestPayout: { betId: string; date: string; payout: number } | null;
    closest: { betId: string; date: string; title?: string; record?: string; losers: number } | null;
    noPayer: number; // settled bets with nobody recorded as paying (bozoId)
    legs: RecordOut;
    bySlot: Record<string, RecordOut>;
    heartbreaks: { betId: string; date: string; playerId: string; text: string; margin: number; game?: string }[];
  };
  players: PlayerStats[];
  votes: Record<string, Record<string, number>>;
  timeline: { betId: string; date: string; title?: string; result?: Result; record?: string; bozoId?: string; nextBozoId?: string; method?: string; odds?: number; legs: Record<string, Result | null> }[];
}

export interface ParsedLeg {
  text: string;
  odds?: number | null;
  sgp?: boolean;
  parsed: Leg["parsed"];
  confidence: number;
}
