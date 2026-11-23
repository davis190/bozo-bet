"""All stats are computed here, deterministically, from raw bets/legs/votes."""
from collections import Counter, defaultdict
from datetime import date, timedelta

from . import odds
from .bets import counted_legs, votes_revealed
from .util import today_ct

# Leg attributes we split records by. parsed.* come from the sheet / leg parser, enrichment.* from the LLM backfill.
SPLITS = {
    "sport": ("parsed", "sport"),
    "market": ("parsed", "market"),
    "subject": ("parsed", "subject"),
    "propType": ("enrichment", "propType"),
    "position": ("enrichment", "position"),
    "slot": ("enrichment", "slot"),
    "favDog": ("enrichment", "favDog"),
    "homeAway": ("enrichment", "homeAway"),
    "divisional": ("enrichment", "divisional"),
    "venue": ("enrichment", "venue"),
    "seasonPhase": ("enrichment", "seasonPhase"),
    "decidedWhen": ("enrichment", "decidedWhen"),
    "oddsBucket": (None, None),
    "dayOfWeek": ("enrichment", "dayOfWeek"),
}


def odds_bucket(a):
    if a is None:
        return "unknown"
    if a <= -200:
        return "-200 or shorter"
    if a <= -150:
        return "-199 to -150"
    if a <= -110:
        return "-149 to -110"
    if a < 100:
        return "-109 to +99"
    if a < 150:
        return "+100 to +149"
    return "+150 or longer"


def _attr(leg, key):
    if key == "oddsBucket":
        return odds_bucket(leg.get("odds"))
    src, field = SPLITS[key]
    v = (leg.get(src) or {}).get(field)
    if isinstance(v, bool):
        v = "yes" if v else "no"
    return v if v not in (None, "") else None


class Rec:
    __slots__ = ("w", "l", "p", "xw", "units", "n_odds", "w_odds")

    def __init__(self):
        self.w = self.l = self.p = self.w_odds = 0
        self.xw = self.units = 0.0
        self.n_odds = 0

    def add(self, leg):
        r = leg.get("result")
        if r == "W":
            self.w += 1
        elif r == "L":
            self.l += 1
        elif r == "P":
            self.p += 1
        else:
            return
        o = leg.get("odds")
        if o is not None and r in ("W", "L"):
            self.n_odds += 1
            self.w_odds += r == "W"
            self.xw += odds.implied_prob(o)
            self.units += odds.flat_bet_units(o, r)

    def out(self):
        decided = self.w + self.l
        return {
            "w": self.w, "l": self.l, "p": self.p,
            "pct": round(self.w / decided, 3) if decided else None,
            "xPct": round(self.xw / self.n_odds, 3) if self.n_odds else None,
            # wins above what the odds said you'd get (legs with known odds only)
            "luck": round(self.w_odds - self.xw, 2) if self.n_odds else None,
            "units": round(self.units, 2),
        }


def _avg_american(values):
    ds = [odds.to_decimal(v) for v in values if v is not None]
    return odds.to_american(sum(ds) / len(ds)) if ds else None


def _streaks(results):
    cur, cur_kind, best = 0, None, {"W": 0, "L": 0}
    run, run_kind = 0, None
    for r in results:
        if r == "P":
            continue
        run = run + 1 if r == run_kind else 1
        run_kind = r
        best[r] = max(best[r], run)
    cur, cur_kind = run, run_kind
    return {"current": f"{cur_kind}{cur}" if cur_kind else None, "longestW": best["W"], "longestL": best["L"]}


def in_range(b, frm, to):
    return (not frm or b["date"] >= frm) and (not to or b["date"] <= to)


def compute(bets, players, frm=None, to=None, kind="bozo", emoji_kinds=None):
    bets = [b for b in bets if b.get("kind") == kind and in_range(b, frm, to)]
    pids = [p["id"] for p in sorted(players, key=lambda p: p["slot"])]
    per = {pid: {
        "rec": Rec(), "splits": defaultdict(lambda: defaultdict(Rec)), "results": [], "odds": [], "winOdds": [],
        "bozo": 0, "voted": 0, "auto": 0, "reload": 0, "spent": 0.0, "won": 0.0,
        "curse": Rec(), "soleKiller": 0, "soleKills": [], "leftOnTable": 0.0, "lostMargin": [], "teams": Counter(),
        "homer": Rec(), "against": Rec(), "crowd": Counter(),
    } for pid in pids}
    favs = {p["id"]: {t["team"] for t in (p.get("favoriteTeams") or []) if t.get("team")} for p in players}
    heartbreaks, group_slots = [], defaultdict(Rec)
    year_ago = (date.fromisoformat(today_ct()) - timedelta(days=365)).isoformat()  # Hall of Heartbreak: last 12 months
    votes = defaultdict(Counter)
    group = {"parlays": 0, "hits": 0, "nearMisses": 0, "xHits": 0.0, "xHitsN": 0, "spent": 0.0, "paidOut": 0.0,
             "biggestPayout": None, "legs": Rec(), "bySize": Counter()}
    timeline = []

    for b in bets:
        legs = counted_legs(b)
        if b.get("status") not in ("CLOSED", "VOTING") and not any(l.get("result") for l in legs):
            continue
        settled = b.get("status") in ("CLOSED", "VOTING")
        losers = [l["playerId"] for l in legs if l.get("result") == "L"]
        if settled:
            group["parlays"] += 1
            group["spent"] += float(b.get("wager") or 0)
            if b.get("result") == "W":
                group["hits"] += 1
                group["paidOut"] += float(b.get("payout") or 0)
                if not group["biggestPayout"] or (b.get("payout") or 0) > group["biggestPayout"]["payout"]:
                    group["biggestPayout"] = {"betId": b["id"], "date": b["date"], "payout": b.get("payout")}
            if len(losers) == 1 and b.get("outcome") != "reload":
                group["nearMisses"] += 1
            probs = [odds.implied_prob(l.get("odds")) for l in legs if l.get("result") != "P"]
            if probs and None not in probs:
                x = 1.0
                for p_ in probs:
                    x *= p_
                group["xHits"] += x
                group["xHitsN"] += 1

        bozo = b.get("bozoId")
        if settled and bozo in per:
            per[bozo]["bozo"] += 1
            per[bozo]["spent"] += float(b.get("wager") or 0)
        nb, how = b.get("nextBozoId"), b.get("nextBozoMethod")
        if nb in per and how in ("voted", "auto", "reload"):
            per[nb][how] += 1
        if b.get("outcome") == "single" and losers and losers[0] in per:
            per[losers[0]]["soleKiller"] += 1
            per[losers[0]]["leftOnTable"] += float(b.get("toWin") or 0)
            killer = next((l for l in legs if l["playerId"] == losers[0]), {})
            per[losers[0]]["soleKills"].append({"betId": b["id"], "date": b["date"], "text": killer.get("text"),
                                                "odds": killer.get("odds"), "toWin": b.get("toWin"), "record": b.get("record")})

        for leg in legs:
            pid = leg["playerId"]
            if pid not in per:
                continue
            s = per[pid]
            s["rec"].add(leg)
            group["legs"].add(leg)
            if leg.get("result"):
                s["results"].append(leg["result"])
            if leg.get("odds") is not None:
                s["odds"].append(leg["odds"])
                if leg.get("result") == "W":
                    s["winOdds"].append(leg["odds"])
            for key in SPLITS:
                v = _attr(leg, key)
                if v is not None:
                    s["splits"][key][v].add(leg)
            if pid == bozo:
                s["curse"].add(leg)
            for emoji, users in (leg.get("reactions") or {}).items():  # Slack verdicts on the leg
                s["crowd"][(emoji_kinds or {}).get(emoji, "unknown")] += len(users)
            if b.get("result") == "W" and b.get("perPerson"):
                s["won"] += float(b["perPerson"])
            en = leg.get("enrichment") or {}
            m = en.get("margin")
            if leg.get("result") == "L" and isinstance(m, (int, float)):
                s["lostMargin"].append(abs(m))
            for t in en.get("teams") or []:
                s["teams"][t] += 1
            mine = favs.get(pid) or set()
            in_game = set((en.get("game") or "").split(" vs "))
            if mine & set(en.get("teams") or []) and en.get("kind") != "game_total":
                s["homer"].add(leg)
            elif mine & in_game and en.get("kind") in ("moneyline", "spread", "team_total"):
                s["against"].add(leg)
            if en.get("slot"):
                group_slots[en["slot"]].add(leg)
            if leg.get("result") == "L" and isinstance(m, (int, float)):
                heartbreaks.append({"betId": b["id"], "date": b["date"], "playerId": pid, "text": leg["text"],
                                    "margin": m, "game": en.get("game")})

        # An open vote stays secret until everyone's in (same rule as the ballot)
        for v in b.get("votes", []) if votes_revealed(b) else []:
            votes[v["voterId"]][v["candidateId"]] += 1
        timeline.append({
            "betId": b["id"], "date": b["date"], "result": b.get("result"), "record": b.get("record"),
            "bozoId": bozo, "nextBozoId": nb, "method": how, "odds": b.get("totalOdds"),
            "legs": {l["playerId"]: l.get("result") for l in legs},
        })

    out_players = []
    for pid in pids:
        s = per[pid]
        if not s["results"] and not s["bozo"]:
            continue
        best_win = max(s["winOdds"], key=lambda o: odds.to_decimal(o), default=None)
        out_players.append({
            "playerId": pid,
            **s["rec"].out(),
            "avgOdds": _avg_american(s["odds"]),
            "avgWinOdds": _avg_american(s["winOdds"]),
            "bestWin": best_win,
            "bozoCount": s["bozo"],
            "votedBozo": s["voted"], "autoBozo": s["auto"], "reloadBozo": s["reload"],
            "spent": round(s["spent"], 2), "won": round(s["won"], 2), "net": round(s["won"] - s["spent"], 2),
            "bozoCurse": s["curse"].out(),
            "soleKiller": s["soleKiller"], "leftOnTable": round(s["leftOnTable"], 2),
            "soleKills": s["soleKills"][::-1],  # newest first
            "badBeatIndex": round(sum(s["lostMargin"]) / len(s["lostMargin"]), 2) if s["lostMargin"] else None,
            "streaks": _streaks(s["results"]),
            "recent": s["results"][-20:],
            "splits": {k: {v: r.out() for v, r in sorted(d.items(), key=lambda x: -(x[1].w + x[1].l))} for k, d in s["splits"].items()},
            "topTeams": s["teams"].most_common(5),
            "homer": s["homer"].out(), "againstTeam": s["against"].out(),
            "crowd": {k: s["crowd"][k] for k in ("up", "down", "neutral", "unknown")},
        })

    g = group
    return {
        "range": {"from": frm, "to": to, "kind": kind},
        "group": {
            "parlays": g["parlays"], "hits": g["hits"],
            "hitRate": round(g["hits"] / g["parlays"], 3) if g["parlays"] else None,
            "expectedHitRate": round(g["xHits"] / g["xHitsN"], 3) if g["xHitsN"] else None,
            "nearMisses": g["nearMisses"],
            "spent": round(g["spent"], 2), "paidOut": round(g["paidOut"], 2),
            "biggestPayout": g["biggestPayout"],
            "legs": g["legs"].out(),
            "bySlot": {k: r.out() for k, r in sorted(group_slots.items(), key=lambda x: -(x[1].w + x[1].l))},
            # closest losses in the last 12 months (margin is negative = missed by that much); ties: newest first
            "heartbreaks": sorted(sorted([h for h in heartbreaks if h["date"] >= year_ago], key=lambda h: h["date"], reverse=True),
                                  key=lambda h: abs(h["margin"]))[:10],
        },
        "players": out_players,
        "votes": {voter: dict(c) for voter, c in votes.items()},
        "timeline": timeline,
    }


def public_summary(bets):
    s = compute(bets, [], kind="bozo")
    return s["group"]
