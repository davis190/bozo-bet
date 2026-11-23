"""Live leg tracker.

Each run:
  1. resolve  - an LLM agent (tool loop over ESPN) maps each leg's text to a precise spec:
                which game, what kind of bet, which team/player/stat, line, over/under
  2. evaluate - code (not the LLM) computes the current value, live status and final W/L/P
  3. settle   - when every leg is decided the bet settles itself (vote/auto-bozo/hit, Slack posts)
  4. schedule - one-time EventBridge Scheduler at() for the next run: 30 min while games are live,
                10 min when a leg is sweating late, next kickoff when nothing is live, nothing when done
Every run is summarized to the Slack logs channel.
"""
import json
import logging
import os
import re
import unicodedata
from datetime import timedelta, timezone

import boto3

from . import bets as rules
from . import db, games, llm, slack
from .util import TZ, ApiError, now_iso

log = logging.getLogger()
log.setLevel(logging.INFO)

# ---------------------------------------------------------------- resolve (agent)
SPEC_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean", "description": "false if the game can't be identified"},
        "sport": {"type": "string"},
        "league": {"type": "string", "description": "ESPN league path from find_games, e.g. football/nfl"},
        "eventId": {"type": "string"},
        "kind": {"type": "string", "enum": ["moneyline", "spread", "game_total", "team_total", "player_stat"]},
        "team": {"type": "string", "description": "Abbreviation of the team picked (moneyline/spread/team_total) as shown by find_games"},
        "player": {"type": "string", "description": "Athlete's full name as it appears in the box score"},
        "stats": {"type": "array", "items": {"type": "string"},
                  "description": "player_stat only: stat keys summed together, e.g. ['passing.TD'] or ['rushing.TD','receiving.TD'] for anytime TD"},
        "statLabel": {"type": "string", "description": "short human label, e.g. 'pass TDs', 'rec yds', 'pts+reb'"},
        "line": {"type": "number", "description": "Spread from the picked team's view (e.g. -16), or the total/prop line. '2+ TDs' = 1.5, 'anytime TD' = 0.5. Moneyline: 0"},
        "direction": {"type": "string", "enum": ["over", "under"], "description": "totals and props only"},
        "drawLoses": {"type": "boolean", "description": "true for 3-way moneylines (soccer): a draw loses"},
        "reason": {"type": "string"},
    },
    "required": ["found", "reason"],
}

TOOLS = [
    {"toolSpec": {"name": "find_games", "description": "List games for a sport between two dates (YYYY-MM-DD, inclusive), optionally filtered by a team name/abbreviation.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "sport": {"type": "string", "enum": list(games.LEAGUES)}, "date_from": {"type": "string"},
                      "date_to": {"type": "string"}, "team": {"type": "string"}}, "required": ["sport", "date_from", "date_to"]}}}},
    {"toolSpec": {"name": "box_score", "description": "Players in a game's box score whose name contains `name` (empty = all), with their team and stat keys. Empty before kickoff.",
                  "inputSchema": {"json": {"type": "object", "properties": {
                      "league": {"type": "string"}, "event_id": {"type": "string"}, "name": {"type": "string"}},
                      "required": ["league", "event_id"]}}}},
    {"toolSpec": {"name": "respond", "description": "Final answer: the leg's tracking spec.", "inputSchema": {"json": SPEC_SCHEMA}}},
]

RESOLVER_PROMPT = """You map a casually written sports bet to the exact game and stat to track, using the tools.
The bet was placed for a parlay dated {date}; its game is usually within a few days of that date (Thursday-Monday for NFL).
Group conventions: 'O'/'U' = over/under, 'ML' = moneyline, 'ATD' = anytime touchdown (rushing+receiving TDs over 0.5),
'tuddies' = touchdowns, 'X+' = over X-0.5, 'TT' = team total, 'alt' lines are just spreads.
For a quarterback, 'TD'/'TDs' means passing TDs unless it says rush/rushing or ATD.
Two teams separated by '/', 'vs' or '-' with O/U means the game total.
Stat keys by sport: {keys}
Call find_games first, then box_score if a player is involved (to confirm the spelling and team). Then call respond.
If you truly can't find the game, respond with found=false and say why."""


def _tool(name, args, cache):
    if name == "find_games":
        lo, hi = games.as_date(args["date_from"]), games.as_date(args["date_to"])
        if (hi - lo).days > 10:
            return {"error": "date range too wide (max 10 days)"}
        gs = games.find_games(args["sport"], lo, hi, args.get("team"))
        return [{"league": g["league"], "eventId": g["id"], "name": g["name"], "start": g["start"], "state": g["state"],
                 "teams": [f"{t['abbr']} ({t['name']}){' home' if t['home'] else ''}" for t in g["teams"]]} for g in gs[:40]]
    if name == "box_score":
        s = games.summary(args["league"], args["event_id"], cache)
        q = _norm(args.get("name") or "")
        return {"state": s["state"], "players": {n: {"team": p["_team"], "stats": sorted(k for k in p if not k.startswith("_"))}
                                                for n, p in s["players"].items() if q in _norm(n)} or "no matching players yet"}
    return {"error": f"unknown tool {name}"}


def resolve(leg, bet_date, cache=None, model=None):
    """Agent loop: up to 8 tool turns, then a spec dict."""
    cache = {} if cache is None else cache
    sport = (leg.get("parsed") or {}).get("sport")
    msg = f"Bet: {leg['text']}" + (f"\nLikely sport: {sport}" if sport else "")
    system = RESOLVER_PROMPT.format(date=bet_date, keys=json.dumps(games.STAT_KEYS))
    messages = [{"role": "user", "content": [{"text": msg}]}]
    for _ in range(8):
        resp = llm._converse(modelId=model or llm.MODELS["track"], system=[{"text": system}], messages=messages,
                             inferenceConfig={"maxTokens": 1500}, toolConfig={"tools": TOOLS})
        out = resp["output"]["message"]
        messages.append(out)
        calls = [b["toolUse"] for b in out["content"] if "toolUse" in b]
        if not calls:
            messages.append({"role": "user", "content": [{"text": "Use the tools, then call respond."}]})
            continue
        results = []
        for c in calls:
            if c["name"] == "respond":
                return c["input"]
            try:
                res = _tool(c["name"], c["input"], cache)
            except Exception as e:  # ESPN hiccup: let the agent see it and adapt
                res = {"error": str(e)[:200]}
            results.append({"toolResult": {"toolUseId": c["toolUseId"], "content": [{"json": {"result": res}}]}})
        messages.append({"role": "user", "content": results})
    return {"found": False, "reason": "agent ran out of steps"}


# ---------------------------------------------------------------- evaluate (deterministic)
ONE_SCORE = {"football": 8, "basketball": 6, "baseball": 2, "hockey": 1, "soccer": 1}


def _norm(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z ]", "", s).strip()


def _find_player(players, name):
    want = _norm(name)
    if not want:
        return None
    for n, p in players.items():
        if _norm(n) == want:
            return p
    first, last = want[0], want.split()[-1]
    hits = [p for n, p in players.items() if _norm(n).split()[-1:] == [last] and _norm(n).startswith(first)]
    return hits[0] if len(hits) == 1 else None


def evaluate(spec, s):
    """-> live dict: status, detail, progress, value, and result when final."""
    sport_family = s["league"].split("/")[0]
    f = games.fraction_elapsed(s["league"], s.get("period"), s.get("clock"), s["state"])
    state, clock = s["state"], s.get("detail") or ""
    teams = {t["abbr"]: t for t in s["teams"]}
    score = " – ".join(f"{t['abbr']} {t['score'] if t['score'] is not None else 0}" for t in s["teams"])
    live = {"state": state, "elapsed": round(f, 2), "updatedAt": now_iso(), "eventId": s["id"], "start": s.get("start")}
    if state == "pre":
        start = games.parse_iso(s.get("start"))
        return {**live, "status": "PENDING", "detail": f"Starts {start.astimezone(TZ):%a %-I:%M %p}" if start else "Not started"}

    kind, line = spec["kind"], float(spec.get("line") or 0)
    final = state == "post"
    if kind in ("moneyline", "spread"):
        me = teams.get(spec.get("team"))
        opp = next((t for a, t in teams.items() if a != spec.get("team")), None)
        if not me or not opp:
            return {**live, "status": "IN_DOUBT", "detail": "Can't find the team in this game", "needsReview": True}
        m = (me["score"] or 0) - (opp["score"] or 0) + (line if kind == "spread" else 0)
        live.update(value=m, detail=f"{clock} · {score}")
        if final:
            result = "W" if m > 0 else "L" if m < 0 or spec.get("drawLoses") else "P"
            return {**live, "status": {"W": "WON", "L": "LOST", "P": "PUSH"}[result], "result": result}
        thr = ONE_SCORE.get(sport_family, 6)
        status = "ON_PACE" if m > thr else "OFF_PACE" if m < -thr else "IN_DOUBT"
        return {**live, "status": status}

    if kind in ("game_total", "team_total"):
        if kind == "game_total":
            v = sum(t["score"] or 0 for t in s["teams"])
        else:
            t = teams.get(spec.get("team"))
            if not t:
                return {**live, "status": "IN_DOUBT", "detail": "Can't find the team in this game", "needsReview": True}
            v = t["score"] or 0
        label = "pts" if sport_family in ("football", "basketball") else "runs" if sport_family == "baseball" else "goals"
        live["detail"] = f"{clock} · {score} · {v:g} {label} (line {line:g})"
    else:  # player_stat
        p = _find_player(s["players"], spec.get("player", ""))
        if p is None:
            if final:
                return {**live, "status": "IN_DOUBT", "detail": f"{spec.get('player')} not in the final box score (DNP?)", "needsReview": True}
            v = 0
        else:
            v = sum(p.get(k) or 0 for k in spec.get("stats") or [])
        live["detail"] = f"{clock} · {v:g} {spec.get('statLabel') or 'stat'} (line {line:g})"

    over = spec.get("direction", "over") == "over"
    live.update(value=v, progress=round(min(1.0, v / line), 3) if line > 0 else None)
    if final:
        result = "P" if v == line else ("W" if (v > line) == over else "L")
        return {**live, "status": {"W": "WON", "L": "LOST", "P": "PUSH"}[result], "result": result}
    if v > line:  # an over that's cleared can't un-clear; an under that's blown is dead
        return {**live, "status": "WON" if over else "LOST", "result": "W" if over else "L"}
    projected = v / max(f, 0.15)
    if over:
        status = "ON_PACE" if projected >= line * 1.1 else "IN_DOUBT" if projected >= line * 0.85 else "OFF_PACE"
    else:
        status = "ON_PACE" if projected <= line * 0.9 else "IN_DOUBT" if projected <= line * 1.1 else "OFF_PACE"
    return {**live, "status": status}


# ---------------------------------------------------------------- run + schedule
ICON = {"WON": "✅", "LOST": "❌", "PUSH": "➖", "ON_PACE": "🟢", "IN_DOUBT": "🟡", "OFF_PACE": "🔴", "PENDING": "⏳"}


def _players():
    return {p["id"]: p for p in db.list_players()}


def run(bet_id, reason="scheduled"):
    bet = db.get_bet_bundle(bet_id)
    if not bet:
        return {"stopped": "no such bet"}
    if bet["status"] not in ("LOCKED", "OPEN"):
        return {"stopped": f"bet is {bet['status']}"}
    settings = db.get_settings()
    tracker = bet.get("tracker") or {"runs": 0, "runsByDay": {}}
    today = games.utcnow().astimezone(TZ).date().isoformat()
    if tracker["runsByDay"].get(today, 0) >= int(settings.get("trackerMaxRunsPerDay") or 40):
        slack.logs(f":octagonal_sign: Tracker hit the daily cap ({settings['trackerMaxRunsPerDay']} runs) for bet {bet['date']}. Stopping.", settings)
        return {"stopped": "daily cap"}

    cache, players, lines, mismatches = {}, _players(), [], []
    for leg in rules.counted_legs(bet):
        name = (players.get(leg["playerId"]) or {}).get("name", leg["playerId"])
        spec = leg.get("track")
        if not spec or not spec.get("found"):
            try:
                spec = {**resolve(leg, bet["date"], cache), "resolvedAt": now_iso()}
            except ApiError as e:
                spec = {"found": False, "reason": e.message}
            leg["track"] = spec
        if not spec.get("found"):
            leg["live"] = {"status": "IN_DOUBT", "detail": f"Tracker couldn't find this one: {spec.get('reason', '')[:120]}",
                           "needsReview": True, "updatedAt": now_iso()}
            db.put_leg(bet, leg)
            lines.append(f"❓ {name}: {leg['text']} — can't find it ({spec.get('reason', '')[:80]})")
            continue
        try:
            live = evaluate(spec, games.summary(spec["league"], spec["eventId"], cache))
        except Exception as e:
            log.exception("evaluate failed")
            live = {"status": "IN_DOUBT", "detail": f"Data hiccup: {str(e)[:80]}", "updatedAt": now_iso()}
        got = live.pop("result", None)
        leg["live"] = live
        if got and not live.get("needsReview"):
            if leg.get("result") and leg["result"] != got:
                mismatches.append(f"{name}: recorded {leg['result']}, tracker says {got}")
            elif not leg.get("result"):
                leg["result"], leg["resultSource"] = got, "tracker"
        db.put_leg(bet, leg)
        lines.append(f"{ICON.get(live['status'], '•')} {name}: {leg['text']} — {live.get('detail', '')}")

    # Everything decided -> settle like the admin would
    outcome = None
    if bet["status"] == "LOCKED" and all(l.get("result") in rules.RESULTS for l in rules.counted_legs(bet)):
        outcome = rules.settle(bet, settings["defaultWager"])
        if bet["kind"] == "bozo":
            (slack.voting_open if outcome == "vote" else slack.new_bozo)(bet, players)

    nxt, why = (None, "all legs decided") if outcome else _next_run(bet, settings)
    tracker["runs"] += 1
    tracker["runsByDay"][today] = tracker["runsByDay"].get(today, 0) + 1
    tracker.update(lastRun=now_iso(), nextRun=nxt.isoformat() if nxt else None, why=why)
    if nxt:
        _schedule(bet, nxt, tracker)
    bet["tracker"] = tracker
    rules._save_meta(bet)

    when = f"next check {nxt.astimezone(TZ):%a %-I:%M %p} CT ({why})" if nxt else f"tracker off ({why})"
    msg = f":satellite: *Bozo tracker* · bet {bet['date']} · run {tracker['runs']} ({reason})\n" + "\n".join(lines) + f"\n_{when}_"
    if mismatches:
        msg += "\n:warning: Doesn't match what was recorded: " + "; ".join(mismatches)
    if outcome:
        msg += f"\n:checkered_flag: All legs decided → settled ({outcome})"
    slack.logs(msg, settings)
    log.info(msg)
    return {"lines": lines, "next": tracker["nextRun"], "why": why, "mismatches": mismatches, "outcome": outcome}


def _next_run(bet, settings):
    now = games.utcnow()
    legs = [l for l in rules.counted_legs(bet) if not l.get("result")]
    live = [l for l in legs if (l.get("live") or {}).get("state") == "in"]
    if live:
        sweating_late = any(l["live"]["status"] == "IN_DOUBT" and l["live"].get("elapsed", 0) >= 0.75 for l in live)
        if sweating_late:
            return now + timedelta(minutes=10), "sweating late — checking every 10 min"
        mins = int(settings.get("trackerDefaultMinutes") or 30)
        return now + timedelta(minutes=mins), f"games live — every {mins} min"
    pending = [l for l in legs if (l.get("live") or {}).get("state") == "pre"]
    if pending:
        upcoming = [s for s in (games.parse_iso(l["live"].get("start")) for l in pending) if s and s > now]
        at = min(upcoming) + timedelta(minutes=5) if upcoming else now + timedelta(hours=1)
        return max(at, now + timedelta(minutes=2)), "waiting for kickoff"
    if legs:
        return None, "needs the admin — some legs can't be tracked"
    return None, "nothing left to track"


def _schedule(bet, at, tracker):
    sched = boto3.client("scheduler")
    if tracker.get("schedule"):
        try:
            sched.delete_schedule(Name=tracker["schedule"])
        except sched.exceptions.ResourceNotFoundException:
            pass
    name = f"bozo-{bet['id']}-{int(at.timestamp())}"
    sched.create_schedule(
        Name=name, ScheduleExpression=f"at({at.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%S})",
        ScheduleExpressionTimezone="UTC", FlexibleTimeWindow={"Mode": "OFF"}, ActionAfterCompletion="DELETE",
        Target={"Arn": os.environ["TRACKER_ARN"], "RoleArn": os.environ["SCHEDULER_ROLE_ARN"],
                "Input": json.dumps({"betId": bet["id"], "reason": "scheduled"})},
    )
    tracker["schedule"] = name


def handler(event, context):
    return run(event["betId"], event.get("reason", "scheduled"))
