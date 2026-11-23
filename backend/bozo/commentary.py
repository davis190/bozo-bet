"""Ballot for a bozo vote: the losing legs, shuffled and nameless, each with fact-grounded color commentary.
We vote on the worst bet, not the person, so nothing here may name a player in the group."""
import hashlib
import logging
import re

from . import bets as rules
from . import llm, odds
from .util import now_iso

log = logging.getLogger()

SCHEMA = {
    "type": "object",
    "properties": {"takes": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "description": "The ballot label exactly as given, e.g. 'Bet A'"},
            "headline": {"type": "string", "description": "Punchy verdict, max 8 words"},
            "take": {"type": "string", "description": "2-3 sentences: why it lost and why it was a bad idea"},
        },
        "required": ["label", "headline", "take"]}}},
    "required": ["takes"],
}

SYSTEM = (llm.BET_CONTEXT +
          "The parlay lost and the group is voting on which losing leg was the WORST BET. You are the color commentator "
          "on the ballot: sarcastic sports-radio energy, short and funny. Rules:\n"
          "- Use ONLY the facts provided. Never invent stats, scores, injuries, quotes or storylines. If a fact is missing, "
          "roast the pick itself (the odds, the line, the matchup) instead.\n"
          "- You only know final numbers, not how the game unfolded: don't describe game flow, momentum or who 'looked' good.\n"
          "- Don't do math that isn't given (no vig or EV calculations); quote the numbers as provided.\n"
          "- Talk about the bet, never the bettor. Don't guess who made it, don't use anyone's name except athletes/teams in the bet.\n"
          "- Good angles: how far it missed, whether it was dead early or a late heartbreak, juice paid for a 'safe' leg, "
          "a long shot that never had a chance, favorite vs underdog, primetime, how it compares to the other losers.\n"
          "- Nothing hateful or about real-life sensitive topics.")


def _label(i):
    return f"Bet {chr(ord('A') + i)}"


def _order(bet, pids):
    """Stable shuffle so ballot order doesn't give away whose leg is whose (slot order would)."""
    return sorted(pids, key=lambda p: hashlib.sha256(f"{bet['id']}:{p}".encode()).hexdigest())


def facts(leg):
    lines = [f"Bet: {leg.get('text')}"]
    o = leg.get("odds")
    if o is not None:
        lines.append(f"Odds: {o:+d} (implied {odds.implied_prob(o):.0%})")
    if leg.get("sgp"):
        lines.append("Same-game parlay leg")
    live = leg.get("live") or {}
    if live.get("detail"):
        lines.append(f"Final from the tracker: {live['detail']}")
    e = leg.get("enrichment") or {}
    if isinstance(e.get("margin"), (int, float)):
        lines.append(f"Missed by: {abs(e['margin']):g}")
    for k, name in (("game", "Game"), ("dayOfWeek", "Day"), ("slot", "Time slot"), ("homeAway", "Side was"),
                    ("favDog", "Side was the"), ("marketSpread", "Closing spread"), ("marketTotal", "Closing total"),
                    ("seasonPhase", "Season"), ("propType", "Prop stat")):
        if e.get(k) not in (None, ""):
            lines.append(f"{name}: {e[k]}")
    if e.get("divisional"):
        lines.append("Divisional game")
    return "\n".join(lines)


def _names(players):
    """What must not show up in the commentary: real names / Slack handles as words, pseudonyms as whole phrases
    (pseudonyms are made of ordinary words like 'The Sloppy Prayer', so their single words are fair game)."""
    words, phrases = set(), set()
    for p in players.values():
        for n in [p.get("name"), *(p.get("slackNames") or [])]:
            words |= {w.lower() for w in re.findall(r"[A-Za-z']{3,}", n or "")}
        if p.get("pseudonym"):
            phrases.add(p["pseudonym"].lower())
    return words, phrases


def _leaks(text, banned, allowed_text):
    words, phrases = banned
    said = {w.lower() for w in re.findall(r"[A-Za-z']{3,}", text)}
    ok = {w.lower() for w in re.findall(r"[A-Za-z']{3,}", allowed_text)}
    return ((said & words) - ok) | {ph for ph in phrases if ph in text.lower()}


def build(bet, players, model=None):
    """-> ballot list [{playerId, label, text, odds, headline, take}] in shuffled order. Never raises."""
    legs = {l["playerId"]: l for l in rules.counted_legs(bet)}
    pids = _order(bet, [c for c in bet.get("candidates", []) if c in legs])
    ballot = [{"playerId": p, "label": _label(i), "text": legs[p].get("text"), "odds": legs[p].get("odds")} for i, p in enumerate(pids)]
    winners = [l.get("text") for l in legs.values() if l.get("result") == "W"]
    sheet = "\n\n".join(f"[{b['label']}]\n{facts(legs[b['playerId']])}" for b in ballot)
    prompt = (f"Parlay record: {bet.get('record')} at {bet.get('totalOdds') or ''} total odds.\n"
              f"Legs that hit (for context): {'; '.join(winners) or 'none'}\n\nLOSING LEGS ON THE BALLOT:\n\n{sheet}")
    try:
        out = llm.structured(SYSTEM, prompt, SCHEMA, model=model, max_tokens=1200, task="commentary")
        takes = {t["label"].strip(): t for t in out.get("takes", [])}
    except Exception:
        log.exception("ballot commentary failed for %s", bet.get("id"))
        takes = {}
    banned, allowed = _names(players), " ".join(l.get("text") or "" for l in legs.values())
    for b in ballot:
        t = takes.get(b["label"])
        if t and not _leaks(t["headline"] + " " + t["take"], banned, allowed):
            b["headline"], b["take"] = t["headline"].strip(), t["take"].strip()
        elif t:
            log.warning("dropped commentary for %s: names a group member", b["label"])
    return ballot


def attach(bet, players):
    """Called when a vote opens: store the ballot on the bet."""
    bet["ballot"] = build(bet, players)
    bet["ballotAt"] = now_iso()
    rules._save_meta(bet)
    return bet["ballot"]
