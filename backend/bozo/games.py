"""Free game data from ESPN's public site API (no key). Normalized so the tracker never sees ESPN's shapes."""
import json
import logging
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger()
BASE = "https://site.api.espn.com/apis/site/v2/sports"

# sport -> ESPN league paths (soccer spans several competitions)
LEAGUES = {
    "NFL": ["football/nfl"],
    "NCAAF": ["football/college-football"],
    "NBA": ["basketball/nba"],
    "NCAAB": ["basketball/mens-college-basketball"],
    "MLB": ["baseball/mlb"],
    "NHL": ["hockey/nhl"],
    "WNBA": ["basketball/wnba"],
    "Soccer": ["soccer/eng.1", "soccer/usa.1", "soccer/uefa.champions", "soccer/esp.1", "soccer/ger.1", "soccer/ita.1", "soccer/fra.1",
               "soccer/fifa.world", "soccer/fifa.friendly", "soccer/fifa.cwc", "soccer/uefa.nations", "soccer/concacaf.gold",
               "soccer/bra.1", "soccer/mex.1", "soccer/eng.fa", "soccer/uefa.europa"],
}
# college scoreboards default to "top 25" games; these groups widen to all of D-I
GROUPS = {"football/college-football": "80", "basketball/mens-college-basketball": "50"}
# regulation length, for "how much of the game is left"
PERIODS = {"football": (4, 15), "basketball/nba": (4, 12), "basketball/mens-college-basketball": (2, 20),
           "baseball": (9, None), "hockey": (3, 20), "soccer": (2, 45)}

_cache = {}


def _get(url, ttl_key=None):
    if ttl_key and ttl_key in _cache:
        return _cache[ttl_key]
    req = urllib.request.Request(url, headers={"user-agent": "bozo-bet/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
    if ttl_key:
        _cache[ttl_key] = data
    return data


def _status(s):
    t = s.get("type", {})
    return {"state": t.get("state"), "completed": bool(t.get("completed")), "detail": t.get("shortDetail") or t.get("detail"),
            "period": s.get("period"), "clock": s.get("displayClock")}


def _event(league, e):
    c = e["competitions"][0]
    teams = [{
        "abbr": x["team"].get("abbreviation"), "name": x["team"].get("displayName"), "short": x["team"].get("shortDisplayName"),
        "home": x.get("homeAway") == "home", "score": int(x["score"]) if str(x.get("score", "")).isdigit() else None,
    } for x in c["competitors"]]
    return {"id": e["id"], "league": league, "name": e.get("shortName") or e.get("name"), "start": e.get("date"),
            "teams": teams, **_status(e.get("status") or c.get("status") or {})}


def scoreboard(league, day):
    q = {"dates": day.strftime("%Y%m%d"), "limit": "400"}
    if league in GROUPS:
        q["groups"] = GROUPS[league]
    try:
        data = _get(f"{BASE}/{league}/scoreboard?{urllib.parse.urlencode(q)}")
    except Exception:
        log.exception("scoreboard failed %s %s", league, day)
        return []
    return [_event(league, e) for e in data.get("events", [])]


def find_games(sport, start, end, query=None):
    """All games for a sport between two dates (inclusive), optionally filtered by team text."""
    out = []
    d = start
    while d <= end:
        for league in LEAGUES.get(sport, []):
            out += scoreboard(league, d)
        d += timedelta(days=1)
    if query:
        q = query.lower()
        out = [g for g in out if any(q in (t[k] or "").lower() for t in g["teams"] for k in ("abbr", "name", "short"))]
    return out


def summary(league, event_id, cache=None):
    """Score, status and every player's box-score stats as {"Name": {"passing.TD": 2, ...}}."""
    key = f"{league}:{event_id}"
    if cache is not None and key in cache:
        return cache[key]
    data = _get(f"{BASE}/{league}/summary?event={event_id}")
    comp = data["header"]["competitions"][0]
    teams = [{"abbr": x["team"].get("abbreviation"), "name": x["team"].get("displayName"), "home": x.get("homeAway") == "home",
              "score": int(x["score"]) if str(x.get("score", "")).isdigit() else None} for x in comp["competitors"]]
    players = {}
    for team in (data.get("boxscore") or {}).get("players", []):
        abbr = team["team"].get("abbreviation")
        for cat in team.get("statistics", []):
            labels = cat.get("labels") or cat.get("keys") or []
            prefix = _category(cat, labels)
            for a in cat.get("athletes", []):
                name = a["athlete"]["displayName"]
                p = players.setdefault(name, {"_team": abbr})
                for label, val in zip(labels, a.get("stats", [])):
                    p[f"{prefix}.{label}"] = _num(val)
    scoring = {t["abbr"]: {"TD": 0, "FG": 0} for t in teams}
    for sp in data.get("scoringPlays") or []:
        abbr = (sp.get("team") or {}).get("abbreviation")
        kind = {"touchdown": "TD", "field-goal": "FG"}.get((sp.get("scoringType") or {}).get("name"))
        if abbr in scoring and kind:
            scoring[abbr][kind] += 1
    pick = (data.get("pickcenter") or [{}])[0]
    home = next((t["abbr"] for t in teams if t["home"]), None)
    away = next((t["abbr"] for t in teams if not t["home"]), None)
    favorite = home if (pick.get("homeTeamOdds") or {}).get("favorite") else away if (pick.get("awayTeamOdds") or {}).get("favorite") else None
    venue = (data.get("gameInfo") or {}).get("venue") or {}
    out = {"league": league, "id": event_id, "teams": teams, "players": players, "start": comp.get("date"),
           "week": data["header"].get("week"), "seasonType": (data["header"].get("season") or {}).get("type"),
           "neutral": comp.get("neutralSite"), "indoor": venue.get("indoor"), "venue": venue.get("fullName"),
           "favorite": favorite, "scoring": scoring, "marketSpread": pick.get("spread"), "marketTotal": pick.get("overUnder"),
           **_status(comp.get("status") or {})}
    if cache is not None:
        cache[key] = out
    return out


def _category(cat, labels):
    """Stable stat-key prefix. ESPN leaves NBA/MLB categories unnamed, and MLB batting and pitching share labels."""
    name = cat.get("name") or cat.get("type")
    if name in ("forwards", "defenses", "skaters"):
        return "skaters"
    if name:
        return name
    if "IP" in labels:
        return "pitching"
    if "AB" in labels:
        return "batting"
    return "stats"


# Stat keys the resolver may use, per sport (prefix.LABEL as produced by summary())
STAT_KEYS = {
    "NFL": "passing.YDS passing.TD passing.INT passing.C/ATT(completions) rushing.CAR rushing.YDS rushing.TD receiving.REC "
           "receiving.YDS receiving.TD kicking.FG kicking.PTS defensive.SACKS",
    "NCAAF": "same as NFL",
    "NBA": "stats.PTS stats.REB stats.AST stats.3PT(made) stats.STL stats.BLK stats.TO",
    "WNBA": "same as NBA",
    "NCAAB": "same as NBA",
    "MLB": "batting.H batting.R batting.RBI batting.HR batting.BB batting.K pitching.K pitching.ER pitching.H pitching.IP",
    "NHL": "skaters.G skaters.A skaters.SOG skaters.BS goalies.SV goalies.GA",
    "Soccer": "box scores are limited; prefer game/team markets",
}


def _num(v):
    """'24/37' -> 24 (completions), '2-12' -> 2, '7.5' -> 7.5, '--' -> None."""
    s = str(v).split("/")[0].split("-")[0] if v not in (None, "") else ""
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def fraction_elapsed(league, period, clock, state):
    """0..1 share of regulation played; used for pace projections."""
    if state == "post":
        return 1.0
    if state != "in" or not period:
        return 0.0
    fam = next((v for k, v in PERIODS.items() if league.startswith(k) or league == k), (4, 15))
    periods, minutes = fam
    if minutes is None:  # baseball: innings
        return min(1.0, (period - 0.5) / periods)
    try:
        m, s = (clock or "0:00").split(":")
        left = int(m) + int(float(s)) / 60
    except ValueError:
        left = 0
    if league.startswith("soccer"):  # soccer clocks count up
        return min(1.0, left / 90)
    return min(1.0, ((period - 1) * minutes + (minutes - left)) / (periods * minutes))


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def utcnow():
    return datetime.now(timezone.utc)


def as_date(s):
    return date.fromisoformat(s[:10])
