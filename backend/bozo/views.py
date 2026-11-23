"""Serialize data for the client, hiding real names from anyone below 'viewer'."""
import os

import boto3

from . import bets as rules
from . import reactions

PUBLIC_PLAYER_FIELDS = ("id", "slot", "color", "avatar", "pseudonym", "active")
PRIVATE_PLAYER_FIELDS = ("name", "favoriteTeams", "roastLevel", "taunt")

_s3 = None


def _slip_url(key):
    global _s3
    if not key:
        return None
    _s3 = _s3 or boto3.client("s3")
    return _s3.generate_presigned_url("get_object", Params={"Bucket": os.environ["SLIP_BUCKET"], "Key": key}, ExpiresIn=3600)


def player(p, names):
    out = {k: p.get(k) for k in PUBLIC_PLAYER_FIELDS}
    if names:
        out.update({k: p.get(k) for k in PRIVATE_PLAYER_FIELDS})
        out["displayName"] = p.get("name")
    else:
        out["displayName"] = p.get("pseudonym") or f"Bozo #{p.get('slot')}"
    return out


def players(ps, names):
    return [player(p, names) for p in sorted(ps, key=lambda p: p.get("slot", 99))]


LEG_FIELDS = ("playerId", "text", "odds", "sgp", "parsed", "result", "resultSource", "live", "source", "submittedAt", "carriedOver", "enrichment")


def bet(b, names, viewer_pid=None, emoji_kinds=None):
    out = {k: v for k, v in b.items() if k not in ("legs", "votes", "slipKey")}
    out["legs"] = [{k: l.get(k) for k in LEG_FIELDS if l.get(k) is not None} for l in b.get("legs", [])]
    for src, l in zip(b.get("legs", []), out["legs"]):
        if src.get("reactions"):
            l["crowd"] = reactions.summarize(src["reactions"], emoji_kinds or reactions.DEFAULT_KINDS)
    for g in b.get("sgpGroups") or []:  # same-game parlay: show the combined price on each of its legs
        for l in out["legs"]:
            if l["playerId"] in (g.get("playerIds") or []):
                l["sgpOdds"] = g.get("odds")
    out["computedOdds"] = rules.computed_odds(b)
    out["hasSlip"] = bool(b.get("slipKey"))
    if names and b.get("slipKey"):
        out["slipUrl"] = _slip_url(b["slipKey"])
    # Votes stay secret until everyone has voted (or the admin closes it)
    if b.get("status") == "VOTING" or b.get("votes"):
        voted = {v["voterId"] for v in b.get("votes", [])}
        out["voting"] = {
            "voters": rules.voters(b),
            "voted": sorted(voted),
            "myVote": next((v["candidateId"] for v in b.get("votes", []) if v["voterId"] == viewer_pid), None),
            "revealed": rules.votes_revealed(b),
        }
        if out["voting"]["revealed"]:
            out["voting"]["votes"] = [{"voterId": v["voterId"], "candidateId": v["candidateId"]} for v in b.get("votes", [])]
            out["voting"]["tally"] = dict(rules.tally(b))
    return out
