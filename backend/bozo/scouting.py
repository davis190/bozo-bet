"""Scouting reports: a sarcastic, data-backed 'what should you bet next' for each player.

The numbers are ours: we compute every split over the player's last 20 legs (the window their page shows) and
all-time. The LLM only picks one split to ride and one to fade *by id* and writes the roast; the records shown
next to each pick come from here, so the model can't invent them. Rebuilt after every settled bet."""
import json
import logging
import os

import boto3

from . import db, llm, slack
from .bets import counted_legs
from .stats import Rec, _attr, _streaks
from .util import now_iso

log = logging.getLogger()
WINDOW = 20
KEYS = ("market", "subject", "favDog", "homeAway", "oddsBucket", "sport", "propType", "slot", "divisional", "dayOfWeek")
NAMES = {
    "market": {"ML": "Moneylines", "Spread": "Spreads", "Over": "Overs", "Under": "Unders"},
    "subject": {"Game": "Game totals/lines", "Team": "Team bets", "Person": "Player props"},
    "favDog": {"Favorite": "Favorites", "Underdog": "Underdogs"},
    "homeAway": {"Home": "Home teams", "Road": "Road teams"},
    "divisional": {"yes": "Divisional games", "no": "Non-division games"},
    "oddsBucket": {"-200 or shorter": "Heavy chalk (-200 or shorter)", "-199 to -150": "Big favorites (-150 to -199)",
                   "-149 to -110": "Juiced favorites (-110 to -149)", "-109 to +99": "Near even money (-109 to +99)",
                   "+100 to +149": "Plus money (+100 to +149)", "+150 or longer": "Long shots (+150 or longer)"},
}

SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "The verdict in 8 words or less"},
        "take": {"type": "string", "description": "1-2 sarcastic sentences, 45 words max"},
        "ride": {"type": "object", "properties": {"id": {"type": "string"}, "why": {"type": "string", "description": "1 sentence"}},
                 "required": ["id", "why"]},
        "fade": {"type": "object", "properties": {"id": {"type": "string"}, "why": {"type": "string", "description": "1 sentence"}},
                 "required": ["id", "why"]},
        "confidence": {"type": "string", "enum": ["lock it in", "lean", "coin flip", "pray"]},
        "nothingTrending": {"type": "boolean"},
    },
    "required": ["headline", "take", "ride", "fade", "confidence", "nothingTrending"],
}

ROAST = {"mild": "Keep it light and friendly.", "spicy": "Roast them, but keep it fun.",
         "no mercy": "No mercy (still nothing hateful or about real-life sensitive topics)."}

SYSTEM = (llm.BET_CONTEXT +
          "You're the group's sarcastic betting scout. Write one player's scouting report for their next leg. Rules:\n"
          "- Talk to the player as 'you'. Never use anyone's name.\n"
          "- Base everything on the splits and legs given. Never invent records, stats or storylines; quote numbers exactly.\n"
          "- 'ride' and 'fade' must be split ids from the list. Ride = what's working lately (good record AND positive units, "
          "ideally backed by all-time too). Fade = what keeps burning them.\n"
          "- Small samples (3-4 legs) are noise; say so if that's all there is.\n"
          "- If nothing is genuinely working, set nothingTrending=true, be brutally honest about it, and still pick the "
          "least-bad option to ride (confidence 'pray').\n"
          "- Short: take is 1-2 sentences (45 words max), each 'why' is one punchy sentence that cites the record. "
          "Sports-radio sarcasm, not a lecture or a stat dump.")


def _label(key, value):
    if key in NAMES and value in NAMES[key]:
        return NAMES[key][value]
    return {"oddsBucket": f"Odds {value}", "propType": f"{value} props", "slot": f"{value} games",
            "sport": f"{value} legs", "dayOfWeek": f"{value} legs"}.get(key, str(value))


def splits(recent, everything):
    """[{id, label, recent: rec, allTime: rec}] for splits with at least 3 decided legs in the window."""
    out = []
    for key in KEYS:
        groups = {}
        for leg in recent:
            v = _attr(leg, key)
            if v is not None and v != "unknown":
                groups.setdefault(v, Rec()).add(leg)
        for v, r in groups.items():
            if r.w + r.l < 3:
                continue
            all_rec = Rec()
            for leg in everything:
                if _attr(leg, key) == v:
                    all_rec.add(leg)
            out.append({"id": f"{key}:{v}", "label": _label(key, v), "recent": r.out(), "allTime": all_rec.out()})
    return sorted(out, key=lambda s: -(s["recent"]["units"]))


def _legs_by_player(bets):
    by = {}
    for b in bets:
        if b.get("kind") != "bozo":
            continue
        for leg in counted_legs(b):
            if leg.get("result") in ("W", "L", "P"):
                by.setdefault(leg["playerId"], []).append({**leg, "date": b["date"]})
    return by


def _rec_text(r):
    return f"{r['w']}-{r['l']}" + (f"-{r['p']}" if r.get("p") else "") + f", {r['units']:+.1f}u"


def build(player, legs, model=None):
    """-> scouting dict for one player, or None without enough history."""
    recent = legs[-WINDOW:]
    if len([l for l in recent if l["result"] in ("W", "L")]) < 5:
        return None
    sp = splits(recent, legs)
    if not sp:
        return None
    window = Rec()
    for leg in recent:
        window.add(leg)
    w = window.out()
    lines = [f"- {s['id']} | {s['label']}: last {WINDOW} {_rec_text(s['recent'])} | all-time {_rec_text(s['allTime'])}" for s in sp]
    history = [f"- {l['date']} {l['text']} ({l.get('odds') if l.get('odds') is not None else 'odds ?'}) -> {l['result']}" for l in recent]
    prompt = (f"Roast level: {player.get('roastLevel') or 'spicy'}. {ROAST.get(player.get('roastLevel') or 'spicy')}\n"
              f"Last {len(recent)} legs: {_rec_text(w)}, win% {w['pct']}, the odds said {w['xPct']}. "
              f"Current streak: {_streaks([l['result'] for l in legs])['current'] or 'none'}.\n\n"
              f"SPLITS (id | label: last {WINDOW} record, units | all-time):\n" + "\n".join(lines) +
              f"\n\nTHEIR LAST {len(recent)} LEGS (oldest first):\n" + "\n".join(history))
    out = llm.structured(SYSTEM, prompt, SCHEMA, model=model, max_tokens=900, task="scout")
    by_id = {s["id"]: s for s in sp}
    report = {"headline": out["headline"].strip(), "take": out["take"].strip(), "confidence": out["confidence"],
              "nothingTrending": bool(out.get("nothingTrending")), "window": {**w, "n": len(recent)}}
    for k in ("ride", "fade"):
        pick = out.get(k) or {}
        if pick.get("id") in by_id:  # the record next to a pick is always our number, never the model's
            report[k] = {**by_id[pick["id"]], "why": pick.get("why", "").strip()}
    if report.get("ride") and report.get("fade") and report["ride"]["id"] == report["fade"]["id"]:
        report.pop("fade")
    return report


def refresh(only=None):
    """Rebuild reports for active players (or just `only`). Returns {pid: headline}."""
    bets = db.all_data()
    settled = [b for b in bets if b.get("kind") == "bozo" and b.get("status") in ("VOTING", "CLOSED")]
    through = settled[-1]["id"] if settled else None
    by = _legs_by_player(bets)
    done = {}
    for p in db.list_players():
        if not p.get("active") or (only and p["id"] not in only):
            continue
        try:
            report = build(p, by.get(p["id"], []))
        except Exception as e:
            log.exception("scouting failed for %s", p["id"])
            slack.ops_error(f"Scouting report for {p.get('name')}", e)
            continue
        if report:
            p["scouting"] = {**report, "generatedAt": now_iso(), "throughBet": through}
            db.put_player(p)
            done[p["id"]] = report["headline"]
    return done


def kick(reason):
    """Fire-and-forget rebuild in its own Lambda so settling never waits on six LLM calls."""
    try:
        boto3.client("lambda").invoke(FunctionName=os.environ.get("SCOUTING_FN", "bozo-bet-scouting"), InvocationType="Event",
                                      Payload=json.dumps({"reason": reason}).encode())
    except Exception:
        log.exception("couldn't start scouting refresh")


def handler(event, context):
    done = refresh(event.get("only"))
    names = {p["id"]: p["name"] for p in db.list_players()}
    slack.ops(f":brain: Scouting reports refreshed ({event.get('reason', 'manual')}):\n"
              + "\n".join(f"• {names.get(pid, pid)}: _{h}_" for pid, h in done.items()))
    return done
