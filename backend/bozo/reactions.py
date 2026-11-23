"""Emoji reactions on leg posts in Slack -> the group's verdict on each leg.
Known emojis count as approve/disapprove; anything else lands in Admin -> Checks until the admin
calls it positive, negative or neutral (stored in settings.emojiKinds)."""
import hashlib
import hmac
import json
import logging
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
