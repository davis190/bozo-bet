"""Weekly public pseudonyms. Color + slot never change, so the group always knows who's who."""
import logging
import random

from . import db, llm, slack
from .bets import counted_legs
from .util import ApiError

log = logging.getLogger()

# Used when Bedrock is unavailable: adjective + noun, still dumb, still anonymous
_ADJ = ["Chalky", "Sweaty", "Busted", "Backdoor", "Degenerate", "Parlay-Brained", "Unhinged", "Sharp-ish", "Fading", "Tilted"]
_NOUN = ["Clown", "Gambler", "Square", "Bookie's Friend", "Lock Merchant", "Prop Goblin", "Underdog", "Casino Regular", "Sweat Lord"]


def _fallback(players):
    rng = random.Random()
    used = set()
    out = {}
    for p in players:
        while True:
            name = f"{rng.choice(_ADJ)} {rng.choice(_NOUN)}"
            if name not in used:
                used.add(name)
                out[p["id"]] = name
                break
    return out


def blocked(name, real, banned=None):
    """True when a pseudonym is empty, contains a real name, or uses one of the player's banned words."""
    n = (name or "").lower()
    return not n or any(r in n for r in real) or any(w.strip().lower() in n for w in banned or [] if w.strip())


def regenerate(only=None):
    players = [p for p in db.list_players() if p.get("active") and (not only or p["id"] in only)]
    bets = [b for b in db.all_data() if b["kind"] == "bozo"][-6:]
    ctx = []
    for p in players:
        recent = [f"{l['text']} ({l.get('result') or 'pending'})" for b in bets for l in counted_legs(b) if l["playerId"] == p["id"]]
        ctx.append({"id": p["id"], "recent": recent or ["no recent bets - a mystery bozo"],
                    "roastLevel": p.get("roastLevel"), "bannedWords": p.get("bannedWords")})
    try:
        names = llm.pseudonyms(ctx)
    except ApiError as e:
        log.warning("pseudonyms: LLM unavailable (%s), using fallback", e.message)
        names = _fallback(players)
    real = {p["name"].lower() for p in db.list_players()}
    for p in players:
        name = names.get(p["id"])
        # Never leak a real name or use a word the player vetoed, even if the model slips one in
        tries = 0
        while blocked(name, real, p.get("bannedWords")) and tries < 50:
            name = _fallback([p])[p["id"]]
            tries += 1
        p["pseudonym"] = name
        db.put_player(p)
    return {p["id"]: p["pseudonym"] for p in players}


def handler(event, context):
    names = regenerate()
    real = {p["id"]: p["name"] for p in db.list_players()}
    slack.ops(":performing_arts: Weekly public names rerolled:\n" + "\n".join(f"• {real.get(pid, pid)} → {n}" for pid, n in names.items()))
    return names
