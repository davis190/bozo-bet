"""Game context for a resolved leg: the raw material for the 'why do I keep losing' stats.
Pure functions over a tracker spec + games.summary(); no LLM."""
import math
from datetime import date, timedelta

from . import games
from .util import TZ

NFL_DIVISIONS = {
    "AFC East": "BUF MIA NE NYJ", "AFC North": "BAL CIN CLE PIT", "AFC South": "HOU IND JAX TEN", "AFC West": "DEN KC LV LAC",
    "NFC East": "DAL NYG PHI WSH", "NFC North": "CHI DET GB MIN", "NFC South": "ATL CAR NO TB", "NFC West": "ARI LAR SF SEA",
}
DIVISION_OF = {t: d for d, teams in NFL_DIVISIONS.items() for t in teams.split()}


def _thanksgiving(year):
    nov1 = date(year, 11, 1)
    return nov1 + timedelta(days=(3 - nov1.weekday()) % 7 + 21)


def nfl_slot(local, season_type):
    if season_type == 3:
        return "Playoffs"
    d = local.date()
    if d == _thanksgiving(d.year):
        return "Thanksgiving"
    if d.month == 12 and d.day == 25:
        return "Christmas"
    if d == _thanksgiving(d.year) + timedelta(days=1):
        return "Black Friday"
    wd, hour = local.weekday(), local.hour
    if wd == 3:
        return "TNF"
    if wd == 0:
        return "MNF"
    if wd == 5:
        return "Saturday"
    if wd == 6:
        if hour < 11:
            return "International"
        if hour < 14:
            return "Early window"
        if hour < 18:
            return "Late window"
        return "SNF"
    return "Other"


def season_phase(sport, local, week, season_type):
    if sport in ("NFL", "NCAAF"):
        if season_type == 3:
            return "Playoffs"
        if week:
            return "Early season" if week <= 6 else "Mid season" if week <= 12 else "Late season"
    return local.strftime("%B")


def whole_margin(m):
    """Scores and stats are whole numbers, so a half-point line is really missed by a whole one:
    an anytime TD with 0 TDs is short 1 TD (not 0.5), -7.5 won by 7 is short 1 point."""
    return (1 if m > 0 else -1) * math.ceil(abs(m)) if m else 0


def derive(spec, s, live):
    """-> enrichment dict for a leg."""
    sport = spec.get("sport") or ""
    start = games.parse_iso(s.get("start"))
    local = start.astimezone(TZ) if start else None
    teams = {t["abbr"]: t for t in s["teams"]}
    abbrs = list(teams)
    # whose side is the bettor on? (picked team, or the player's team)
    side = spec.get("team")
    if spec.get("kind") == "player_stat":
        from .tracker import _find_player
        p = _find_player(s["players"], spec.get("player", ""))
        side = (p or {}).get("_team") or side
    e = {
        "eventId": s["id"], "league": s["league"], "game": " vs ".join(abbrs), "teams": [side] if side else abbrs,
        "kind": spec.get("kind"), "propType": spec.get("statLabel") if spec.get("kind") == "player_stat" else None,
        "dayOfWeek": local.strftime("%A") if local else None,
        "slot": (nfl_slot(local, s.get("seasonType")) if sport == "NFL" else ("Night" if local.hour >= 18 else "Day")) if local else None,
        "seasonPhase": season_phase(sport, local, s.get("week"), s.get("seasonType")) if local else None,
        "venue": "Dome" if s.get("indoor") else "Outdoors" if s.get("indoor") is False else None,
        "marketSpread": s.get("marketSpread"), "marketTotal": s.get("marketTotal"),
    }
    if side in teams and not s.get("neutral"):
        e["homeAway"] = "Home" if teams[side]["home"] else "Road"
    if side and s.get("favorite"):
        e["favDog"] = "Favorite" if side == s["favorite"] else "Underdog"
    if sport == "NFL" and len(abbrs) == 2:
        e["divisional"] = DIVISION_OF.get(abbrs[0]) is not None and DIVISION_OF.get(abbrs[0]) == DIVISION_OF.get(abbrs[1])
    if e["slot"] in ("TNF", "SNF", "MNF"):
        e["primetime"] = True
    # margin from the bettor's point of view: + = cleared by that much, - = missed by that much
    v, line = live.get("value"), float(spec.get("line") or 0)
    if v is not None:
        if spec.get("kind") in ("moneyline", "spread"):
            e["margin"] = whole_margin(v)
        else:
            e["margin"] = whole_margin((v - line) if spec.get("direction", "over") == "over" else (line - v))
    return {k: v for k, v in e.items() if v is not None}
