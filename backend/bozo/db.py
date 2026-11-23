"""Single-table DynamoDB access.

pk / sk                      gsi1pk / gsi1sk           entity
PLAYER#<id> / META           PLAYER / <slot>           player (real name lives here only)
USER#<sub>  / META           USER / <email>            login account -> role + playerId
BET#<id>    / META           BET / <date>#<seq>        bet (bozo or side)
BET#<id>    / LEG#<playerId> LEG / <date>#<id>#<pid>   one player's leg
BET#<id>    / VOTE#<voter>   VOTE / <date>#<id>        bozo vote
BET#<id>    / RX#<pid>#<emoji>#<slackUser>  RX / ...     one emoji reaction on a leg's Slack post
SLACKMSG#<channel>#<ts> / META                          which leg a Slack post is about
SETTINGS    / GLOBAL                                   app settings
"""
import os

import boto3
from boto3.dynamodb.conditions import Key

from .util import from_dynamo, to_dynamo

_table = None


def table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _table


def _strip(item):
    if not item:
        return None
    item = from_dynamo(item)
    for k in ("pk", "sk", "gsi1pk", "gsi1sk"):
        item.pop(k, None)
    return item


def _query_all(**kwargs):
    items, start = [], None
    while True:
        if start:
            kwargs["ExclusiveStartKey"] = start
        resp = table().query(**kwargs)
        items.extend(resp["Items"])
        start = resp.get("LastEvaluatedKey")
        if not start:
            return items


def _by_type(kind):
    return [_strip(i) for i in _query_all(IndexName="gsi1", KeyConditionExpression=Key("gsi1pk").eq(kind))]


# ---------- players ----------
def player_item(p):
    return {"pk": f"PLAYER#{p['id']}", "sk": "META", "gsi1pk": "PLAYER", "gsi1sk": f"{p['slot']:03d}", **p}


def list_players():
    return _by_type("PLAYER")


def get_player(pid):
    return _strip(table().get_item(Key={"pk": f"PLAYER#{pid}", "sk": "META"}).get("Item"))


def put_player(p):
    table().put_item(Item=to_dynamo(player_item(p)))


# ---------- users ----------
def get_user(sub):
    return _strip(table().get_item(Key={"pk": f"USER#{sub}", "sk": "META"}).get("Item"))


def put_user(u):
    table().put_item(Item=to_dynamo({"pk": f"USER#{u['sub']}", "sk": "META", "gsi1pk": "USER", "gsi1sk": u.get("email", ""), **u}))


def list_users():
    return _by_type("USER")


# ---------- bets ----------
def bet_item(b):
    return {"pk": f"BET#{b['id']}", "sk": "META", "gsi1pk": "BET", "gsi1sk": f"{b['date']}#{b.get('seq', 0):02d}", **b}


def leg_item(bet, leg):
    return {
        "pk": f"BET#{bet['id']}", "sk": f"LEG#{leg['playerId']}",
        "gsi1pk": "LEG", "gsi1sk": f"{bet['date']}#{bet['id']}#{leg['playerId']}",
        "betId": bet["id"], **{k: v for k, v in leg.items() if k != "reactions"},  # reactions are their own items
    }


def vote_item(bet, vote):
    return {
        "pk": f"BET#{bet['id']}", "sk": f"VOTE#{vote['voterId']}",
        "gsi1pk": "VOTE", "gsi1sk": f"{bet['date']}#{bet['id']}",
        "betId": bet["id"], **vote,
    }


def put_bet(b):
    table().put_item(Item=to_dynamo(bet_item(b)))


def put_leg(bet, leg):
    table().put_item(Item=to_dynamo(leg_item(bet, leg)))


def delete_leg(bet_id, player_id):
    table().delete_item(Key={"pk": f"BET#{bet_id}", "sk": f"LEG#{player_id}"})


def put_vote(bet, vote):
    table().put_item(Item=to_dynamo(vote_item(bet, vote)))


def get_bet_bundle(bet_id):
    """Bet meta + its legs + votes in one query."""
    items = [from_dynamo(i) for i in _query_all(KeyConditionExpression=Key("pk").eq(f"BET#{bet_id}"))]
    meta = next((_strip(dict(i)) for i in items if i["sk"] == "META"), None)
    if not meta:
        return None
    meta["legs"] = [_strip(dict(i)) for i in items if i["sk"].startswith("LEG#")]
    meta["votes"] = [_strip(dict(i)) for i in items if i["sk"].startswith("VOTE#")]
    _attach_reactions(meta["legs"], [i for i in items if i["sk"].startswith("RX#")])
    return meta


def _attach_reactions(legs, rx):
    by = {l["playerId"]: l for l in legs}
    for r in rx:
        if r["playerId"] in by:
            by[r["playerId"]].setdefault("reactions", {}).setdefault(r["emoji"], []).append(r["user"])


def put_slack_msg(channel, ts, bet, player_id):
    table().put_item(Item={"pk": f"SLACKMSG#{channel}#{ts}", "sk": "META", "betId": bet["id"], "date": bet["date"], "playerId": player_id})


def get_slack_msg(channel, ts):
    return _strip(table().get_item(Key={"pk": f"SLACKMSG#{channel}#{ts}", "sk": "META"}).get("Item"))


def _rx_key(msg, emoji, user):
    return {"pk": f"BET#{msg['betId']}", "sk": f"RX#{msg['playerId']}#{emoji}#{user}"}


def put_reaction(msg, emoji, user):
    table().put_item(Item={**_rx_key(msg, emoji, user), "gsi1pk": "RX", "gsi1sk": f"{msg['date']}#{msg['betId']}#{msg['playerId']}",
                           "betId": msg["betId"], "playerId": msg["playerId"], "emoji": emoji, "user": user})


def delete_reaction(msg, emoji, user):
    table().delete_item(Key=_rx_key(msg, emoji, user))


def list_bets():
    return sorted(_by_type("BET"), key=lambda b: (b["date"], b.get("seq", 0)))


def all_data():
    """Everything stats needs: bets with legs + votes attached. A few hundred items total."""
    bets = {b["id"]: {**b, "legs": [], "votes": []} for b in _by_type("BET")}
    for leg in _by_type("LEG"):
        if leg["betId"] in bets:
            bets[leg["betId"]]["legs"].append(leg)
    for v in _by_type("VOTE"):
        if v["betId"] in bets:
            bets[v["betId"]]["votes"].append(v)
    rx = {}
    for r in _by_type("RX"):
        rx.setdefault(r["betId"], []).append(r)
    for bid, items in rx.items():
        if bid in bets:
            _attach_reactions(bets[bid]["legs"], items)
    return sorted(bets.values(), key=lambda b: (b["date"], b.get("seq", 0)))


# ---------- settings ----------
DEFAULT_SETTINGS = {
    "defaultWager": 10,
    "slackChannelMain": "",  # channel IDs (C…), bot token lives in Secrets Manager
    "slackChannelOps": "",
    "emojiKinds": {},  # admin's calls on emojis: {name: up|down|neutral}
    "oracleDailyLimit": 10,
    "trackerDefaultMinutes": 30,
    "trackerMaxRunsPerDay": 40,
}


def get_settings():
    item = _strip(table().get_item(Key={"pk": "SETTINGS", "sk": "GLOBAL"}).get("Item")) or {}
    return {**DEFAULT_SETTINGS, **item}


def put_settings(s):
    table().put_item(Item=to_dynamo({"pk": "SETTINGS", "sk": "GLOBAL", **s}))


def batch_put(items):
    with table().batch_writer() as w:
        for i in items:
            w.put_item(Item=to_dynamo(i))
