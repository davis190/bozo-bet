"""Emoji reactions on leg posts in Slack -> the group's verdict on each leg.
Known emojis count as approve/disapprove; anything else lands in Admin -> Checks until the admin
calls it positive, negative or neutral (stored in settings.emojiKinds)."""
import hashlib
import hmac
import json
import logging
import re
import time

import boto3

from . import db, slack

log = logging.getLogger()

UP, DOWN, NEUTRAL = "up", "down", "neutral"
# Starting point; the admin's calls in settings.emojiKinds override these
DEFAULT_KINDS = {
    **{e: UP for e in ("+1", "thumbsup", "white_check_mark", "heavy_check_mark", "fire", "moneybag", "100", "money_mouth_face",
                       "muscle", "raised_hands", "clap", "star-struck", "heart_eyes", "goat", "lock", "rocket", "moneybag",
                       "chart_with_upwards_trend", "heart", "ok_hand", "sunglasses", "dart", "trophy", "dollar", "money_with_wings")},
    **{e: DOWN for e in ("-1", "thumbsdown", "x", "skull", "skull_and_crossbones", "clown_face", "hankey", "poop", "wastebasket",
                         "nauseated_face", "face_vomiting", "no_entry_sign", "rolling_eyes", "facepalm", "face_palm", "chart_with_downwards_trend",
                         "coffin", "headstone", "toilet", "grimacing", "warning", "rotating_light", "no_entry")},
}

_secret = None


def kinds(settings=None):
    return {**DEFAULT_KINDS, **((settings or db.get_settings()).get("emojiKinds") or {})}


def base(name):
    """':+1::skin-tone-3:' arrives as '+1::skin-tone-3' -> '+1'."""
    return (name or "").split("::")[0]


def summarize(reactions, k):
    """{emoji: [slack user ids]} -> {"up", "down", "neutral", "unknown", "emojis": [[name, count, kind]]}."""
    out = {UP: 0, DOWN: 0, NEUTRAL: 0, "unknown": 0, "emojis": []}
    for name, users in sorted((reactions or {}).items(), key=lambda x: -len(x[1])):
        kind = k.get(name, "unknown")
        out[kind] += len(users)
        out["emojis"].append([name, len(users), kind])
    return out


def same_bet(a, b):
    """Two versions of a leg are the same bet when the words match; odds in parentheses don't count."""
    norm = lambda t: re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", "", (t or "").lower())).strip()
    return norm(a) == norm(b)


def new_leg_post(channel, ts, bet, leg):
    """Track a fresh leg post. If the player switched to a different bet, the old posts stop counting
    (their reactions were about a bet that no longer exists), then the leg's reactions are rebuilt from what's left."""
    for m in db.list_slack_msgs():
        if m["betId"] == bet["id"] and m["playerId"] == leg["playerId"] and not same_bet(m.get("text"), leg["text"]):
            db.delete_slack_msg(m["channel"], m["ts"])
    db.put_slack_msg(channel, ts, bet, leg["playerId"], leg["text"])
    _sync_legs({(bet["id"], leg["playerId"])})


# ---------------- Slack Events API ----------------
def _signing_secret():
    global _secret
    if _secret is None:
        _secret = json.loads(boto3.client("secretsmanager").get_secret_value(SecretId=slack.SECRET_ID)["SecretString"])["signing_secret"]
    return _secret


def verify(headers, raw):
    """Slack's v0 HMAC signature over the raw body; rejects anything older than 5 minutes (replays)."""
    h = {k.lower(): v for k, v in (headers or {}).items()}
    ts, sig = h.get("x-slack-request-timestamp", ""), h.get("x-slack-signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    mine = "v0=" + hmac.new(_signing_secret().encode(), f"v0:{ts}:{raw}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mine, sig)


def handle(payload):
    """-> response body for Slack. Reactions on anything but a tracked leg post are ignored."""
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}
    e = payload.get("event") or {}
    if e.get("type") not in ("reaction_added", "reaction_removed") or (e.get("item") or {}).get("type") != "message":
        return {"ok": True}
    msg = db.get_slack_msg(e["item"].get("channel"), e["item"].get("ts"))
    if not msg:
        return {"ok": True}
    name = base(e.get("reaction"))
    if e["type"] == "reaction_added":
        db.put_reaction(msg, name, e.get("user"))
    else:
        db.delete_reaction(msg, name, e.get("user"))
    return {"ok": True}


def sync(since_days=21):
    """Backup for the Events API: read reactions straight off recent tracked leg posts and make the stored ones match.
    Needs only channels/groups:history. Returns (added, removed)."""
    cutoff = time.time() - since_days * 86400
    return _sync_legs({(m["betId"], m["playerId"]) for m in db.list_slack_msgs() if float(m["ts"]) >= cutoff})


def _sync_legs(legs):
    """Make stored reactions for these (betId, playerId) legs match their tracked Slack posts exactly."""
    added = removed = 0
    posts = [m for m in db.list_slack_msgs() if (m["betId"], m["playerId"]) in legs]
    want = {leg: set() for leg in legs}
    msg_for = {}
    for m in posts:
        out = slack.api("conversations.history", channel=m["channel"], latest=m["ts"], oldest=m["ts"], inclusive="true", limit=1)
        if not out.get("ok"):
            return added, removed  # can't see Slack right now: change nothing rather than wipe reactions
        msg = (out.get("messages") or [{}])[0]
        key = (m["betId"], m["playerId"])
        msg_for[key] = m
        want[key] |= {(base(r["name"]), u) for r in msg.get("reactions", []) for u in r.get("users", [])}
    for (bet_id, pid), w in want.items():
        stored = db.list_reactions(bet_id, pid)
        have = {(r["emoji"], r["user"]) for r in stored}
        target = msg_for.get((bet_id, pid)) or {"betId": bet_id, "playerId": pid, "date": (stored[0].get("gsi1sk", "")[:10] if stored else "")}
        for emoji, user in w - have:
            db.put_reaction(target, emoji, user)
            added += 1
        for emoji, user in have - w:
            db.delete_reaction(target, emoji, user)
            removed += 1
    return added, removed
