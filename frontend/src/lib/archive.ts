import type { Bet, Leg, Player } from "./types";

/** Archive filters. Every field lives in the URL so a filtered view can be shared. */
export interface ArchiveFilter {
  q: string;
  bozo: string; // made bozo by this bet
  by: string; // placed by
  sank: string; // missed a leg
  leg: string; // had a leg in it; also narrows the text search to their legs
  res: "" | "hit" | "miss" | "close" | "reload" | "open";
  how: string; // nextBozoMethod
  sport: string;
  rec: string; // normalized "W-L" / "W-L-P"
  from: string;
  to: string;
  sort: "new" | "old" | "odds" | "best" | "worst";
}

export const FILTER_KEYS = ["q", "bozo", "by", "sank", "leg", "res", "how", "sport", "rec", "from", "to", "sort"] as const;

export const RESULTS: Record<Exclude<ArchiveFilter["res"], "">, string> = {
  hit: "💰 Hits",
  miss: "💀 Misses",
  close: "😩 Missed by one",
  reload: "🔁 Reloads",
  open: "⏳ In progress",
};

export const SORTS: Record<ArchiveFilter["sort"], string> = { new: "Newest", old: "Oldest", odds: "Longest odds", best: "Most legs hit", worst: "Fewest legs hit" };

export const counted = (b: Bet) => b.legs.filter((l) => !l.carriedOver);
export const losers = (b: Bet) => counted(b).filter((l) => l.result === "L");

/** Older bets store "6-1", newer ones "6-1-0": both mean 6-1. Falls back to counting the legs. */
export function normRecord(b: Bet) {
  const m = (b.record ?? "").match(/^(\d+)-(\d+)(?:-(\d+))?$/);
  const [w, l, p] = m ? [m[1], m[2], m[3] ?? "0"].map(Number) : (["W", "L", "P"] as const).map((r) => counted(b).filter((x) => x.result === r).length);
  return !m && !w && !l && !p ? "" : `${w}-${l}${p ? `-${p}` : ""}`;
}

const wins = (b: Bet) => Number(normRecord(b).split("-")[0] || 0);

export function outcomeOf(b: Bet): ArchiveFilter["res"] {
  if (b.status !== "CLOSED" && b.status !== "VOTING") return "open";
  if (b.result === "W") return "hit";
  if (b.outcome === "reload") return "reload";
  return "miss";
}

const DATE_WORDS = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const f = (o: Intl.DateTimeFormatOptions) => dt.toLocaleDateString("en-US", o);
  return [iso, f({ month: "long" }), f({ month: "short" }), f({ weekday: "long" }), `${m}/${d}`, `${m}/${d}/${y}`, `${m}/${d}/${String(y).slice(2)}`].join(" ");
};

/** Text the search box matches: legs, title, sport, dates, record and the people with a role in the bet
 * (bozo, placed by, who sank it). Everyone with a leg would match almost every bet, so names on legs only
 * count through the "had a leg" filter. */
function haystack(b: Bet, players: Record<string, Player>, legs: Leg[]) {
  const name = (id?: string) => (id ? players[id]?.displayName ?? "" : "");
  return [
    b.title,
    ...legs.map((l) => `${l.text} ${l.parsed?.subject ?? ""} ${l.parsed?.player ?? ""} ${(l.parsed?.teams ?? []).join(" ")} ${l.parsed?.sport ?? ""} ${l.parsed?.market ?? ""}`),
    name(b.nextBozoId), name(b.bozoId), ...losers(b).map((l) => name(l.playerId)),
    DATE_WORDS(b.date), b.result === "W" ? "hit won cash" : "",
  ].join(" ").toLowerCase();
}

export const sportsOf = (b: Bet) => new Set(counted(b).map((l) => l.parsed?.sport).filter(Boolean) as string[]);

/** Bets matching the filter (all text words must match), sorted, plus the legs that explain a text match. */
export function search(bets: Bet[], f: ArchiveFilter, players: Record<string, Player>) {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: { bet: Bet; hits: Leg[] }[] = [];
  for (const b of bets) {
    const legs = f.leg ? counted(b).filter((l) => l.playerId === f.leg) : counted(b);
    if (f.leg && !legs.length) continue;
    if (f.bozo && b.nextBozoId !== f.bozo) continue;
    if (f.by && b.bozoId !== f.by) continue;
    if (f.sank && !losers(b).some((l) => l.playerId === f.sank)) continue;
    if (f.res === "close" ? !(outcomeOf(b) === "miss" && losers(b).length === 1) : f.res && outcomeOf(b) !== f.res) continue;
    if (f.how && b.nextBozoMethod !== f.how) continue;
    if (f.sport && !sportsOf(b).has(f.sport)) continue;
    if (f.rec && normRecord(b) !== f.rec) continue;
    if ((f.from && b.date < f.from) || (f.to && b.date > f.to)) continue;
    // "5-1" is a record, not part of a date like 2025-11-02
    const hay = words.length ? haystack(b, players, legs) : "";
    if (!words.every((w) => (/^\d+-\d+(-\d+)?$/.test(w) ? normRecord(b) === w.replace(/-0$/, "") : hay.includes(w)))) continue;
    // Legs worth showing under the row: the ones the words hit, or the filtered player's leg
    const hits = words.length ? legs.filter((l) => words.some((w) => l.text.toLowerCase().includes(w))) : f.leg ? legs : [];
    out.push({ bet: b, hits });
  }
  const odds = (b: Bet) => b.totalOdds ?? b.computedOdds ?? 0;
  const by: Record<ArchiveFilter["sort"], (a: Bet, b: Bet) => number> = {
    new: (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
    old: (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    odds: (a, b) => odds(b) - odds(a),
    best: (a, b) => wins(b) - wins(a) || b.date.localeCompare(a.date),
    worst: (a, b) => wins(a) - wins(b) || b.date.localeCompare(a.date),
  };
  return out.sort((x, y) => by[f.sort || "new"](x.bet, y.bet));
}

/** One-line rundown of what's on screen: hits, and who got made bozo / sank it the most. */
export function rundown(rows: { bet: Bet }[]) {
  const tally = (ids: (string | undefined)[]) => {
    const n: Record<string, number> = {};
    ids.forEach((id) => id && (n[id] = (n[id] ?? 0) + 1));
    const top = Object.entries(n).sort((a, b) => b[1] - a[1]);
    return top.length && top[0][1] > 1 ? { id: top[0][0], n: top[0][1], tied: top.length > 1 && top[1][1] === top[0][1] } : null;
  };
  const bets = rows.map((r) => r.bet);
  return {
    hits: bets.filter((b) => b.result === "W").length,
    bozo: tally(bets.filter((b) => b.nextBozoMethod && b.nextBozoMethod !== "stays" && b.nextBozoMethod !== "kept").map((b) => b.nextBozoId)),
    sank: tally(bets.flatMap((b) => losers(b).map((l) => l.playerId))),
  };
}
