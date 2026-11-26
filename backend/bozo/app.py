"""HTTP API entry point. /public/* is anonymous, /api/* requires a Cognito ID token."""
import base64
import json
import logging
import os
import re

import boto3

from . import auth, commentary, db, llm, reactions, scouting, slack, stats, views
from . import bets as rules
from .util import ApiError, new_id, now_iso, response, today_ct

log = logging.getLogger()
log.setLevel(logging.INFO)

ROUTES = []


def route(method, pattern, role="public"):
    rx = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "$")

    def deco(fn):
        ROUTES.append((method, rx, role, fn))
        return fn
    return deco


class Req:
    def __init__(self, event, user, params):
        self.event, self.user, self.params = event, user, params
        self.query = event.get("queryStringParameters") or {}
        body = event.get("body") or ""
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode()
        self.raw, self.headers = body, event.get("headers") or {}
        self.body = json.loads(body) if body else {}
        self.names = auth.can_see_names(user)
        self._kinds = None

    @property
    def kinds(self):
        """Emoji -> up/down/neutral, loaded once per request."""
        if self._kinds is None:
            self._kinds = reactions.kinds()
        return self._kinds


def _players():
    return {p["id"]: p for p in db.list_players()}


def _bundle(bet_id):
    b = db.get_bet_bundle(bet_id)
    if not b:
        raise ApiError(404, "No such bet")
    return b


def _present(req, b):
    return views.bet(b, req.names, req.user.get("playerId"), req.kinds)


# ---------------- shared read endpoints (public + authed variants) ----------------
def current(req):
    all_bets = db.list_bets()
    bozo_id = rules.current_bozo_id(all_bets)
    cur = rules.current_bet(all_bets)
    open_side = [b for b in all_bets if b["kind"] == "side" and b["status"] != "CLOSED"]
    last = next((b for b in reversed(all_bets) if b["kind"] == "bozo" and b["status"] == "CLOSED"), None)
    return {
        "currentBozoId": bozo_id,
        "bet": _present(req, _bundle(cur["id"])) if cur else None,
        "lastBet": _present(req, _bundle(last["id"])) if last else None,
        "sideBets": [_present(req, _bundle(b["id"])) for b in open_side],
        "players": views.players(db.list_players(), req.names),
        "droughts": rules.bozo_droughts(all_bets, today_ct()),
        "settings": {"defaultWager": db.get_settings()["defaultWager"]},
    }


route("GET", "/public/current")(current)
route("GET", "/api/current", "none")(current)


@route("GET", "/public/summary")
def public_summary(req):
    return stats.public_summary(db.all_data())


@route("GET", "/api/me", "none")
def me(req):
    u = dict(req.user)
    p = db.get_player(u["playerId"]) if u.get("playerId") else None
    me_ = views.player(p, True) if p else None
    if me_:
        me_["bannedWords"] = p.get("bannedWords") or []  # only ever shown to the player themselves
    return {"user": u, "player": me_}


@route("PUT", "/api/me/profile", "player")
def update_profile(req):
    p = db.get_player(auth.player_id(req.user))
    allowed = {"avatar", "favoriteTeams", "roastLevel", "taunt", "bannedWords", "theme"}
    for k, v in req.body.items():
        if k in allowed:
            p[k] = v
    if p.get("roastLevel") not in (None, "mild", "spicy", "no mercy"):
        raise ApiError(400, "roastLevel must be mild, spicy or no mercy")
    db.put_player(p)
    return views.player(p, True)


@route("GET", "/api/bets", "viewer")
def list_bets(req):
    kind = req.query.get("kind")
    out = [b for b in db.all_data() if not kind or b["kind"] == kind]
    return {"bets": [_present(req, b) for b in reversed(out)], "players": views.players(db.list_players(), True)}


@route("GET", "/api/bets/{betId}", "viewer")
def get_bet(req):
    return _present(req, _bundle(req.params["betId"]))


@route("GET", "/api/stats", "viewer")
def get_stats(req):
    q = req.query
    return stats.compute(db.all_data(), db.list_players(), q.get("from"), q.get("to"), q.get("kind", "bozo"), req.kinds)


# ---------------- player actions ----------------
def _notify_leg(bet, leg, was_complete):
    players = _players()
    try:
        active = [p for p in players.values() if p.get("active")]
        complete = len(rules.counted_legs(bet)) >= len(active)
        settings = db.get_settings()
        # Every leg gets its own post so the group can react to it; reactions map back via the ts
        ts = slack.leg_submitted(bet, leg, players, count=(len(rules.counted_legs(bet)), len(active)), settings=settings)
        if ts:
            reactions.new_leg_post(settings["slackChannelMain"], ts, bet, leg)
        if complete:
            slack.legs_summary(bet, players, changed=was_complete)
    except Exception:
        log.exception("notify failed")


@route("POST", "/api/legs/parse", "player")
def parse_leg(req):
    """Free text -> structured leg + a reality check from your own history."""
    raw = (req.body.get("text") or "").strip()
    if not raw:
        raise ApiError(400, "Type a bet first")
    parsed = llm.parse_leg(rules.plus_to_over(raw))
    pid = auth.player_id(req.user)
    s = stats.compute(db.all_data(), db.list_players())
    me_ = next((p for p in s["players"] if p["playerId"] == pid), None)
    history = []
    if me_:
        p = parsed.get("parsed", {})
        for key, val in (("sport", p.get("sport")), ("market", p.get("market")), ("subject", p.get("subject"))):
            r = (me_["splits"].get(key) or {}).get(val)
            if r and r["w"] + r["l"] >= 3:
                history.append({"label": f"{val} bets", "w": r["w"], "l": r["l"], "pct": r["pct"]})
    cur = db.get_bet_bundle(req.body["betId"]) if req.body.get("betId") else rules.current_bet(db.list_bets())
    return {"leg": parsed, "history": history,
            "floorWarning": rules.floor_warning(cur, parsed.get("odds")) if cur else None}


@route("PUT", "/api/bets/{betId}/my-leg", "player")
def submit_my_leg(req):
    pid = auth.player_id(req.user)
    bet = _bundle(req.params["betId"])
    was_complete = len(rules.counted_legs(bet)) >= len([p for p in _players().values() if p.get("active")])
    leg = rules.upsert_leg(bet, pid, req.body, "app")
    _notify_leg(bet, leg, was_complete)
    return {"bet": _present(req, bet), "floorWarning": rules.floor_warning(bet, leg.get("odds"))}


@route("POST", "/api/bets/{betId}/vote", "player")
def vote(req):
    pid = auth.player_id(req.user)
    bet = rules.cast_vote(_bundle(req.params["betId"]), pid, req.body.get("candidateId"))
    if bet["status"] == "CLOSED":
        slack.vote_results(bet, _players())
    elif bet.get("tie") and rules.votes_revealed(bet):
        slack.vote_tie(bet, _players())
    return _present(req, bet)


# ---------------- admin ----------------
@route("POST", "/api/admin/bets", "admin")
def admin_create_bet(req):
    b = req.body
    settings = db.get_settings()
    bet = rules.create_bet(b.get("kind", "bozo"), b.get("date") or today_ct(), b.get("wager") or settings["defaultWager"],
                           bozo_id=b.get("bozoId"), title=b.get("title"), betting_floor=b.get("bettingFloor"))
    if bet["kind"] == "bozo":
        slack.bet_open(bet, _players())
    return _present(req, bet)


@route("PATCH", "/api/admin/bets/{betId}", "admin")
def admin_update_bet(req):
    bet = _bundle(req.params["betId"])
    editable = {"date", "title", "wager", "bettingFloor", "bozoId", "totalOdds", "toWin", "payout", "perPerson",
                "nextBozoId", "nextBozoMethod", "status", "result", "notes", "sgpGroups", "noVote"}
    for k, v in req.body.items():
        if k in editable:
            bet[k] = v
    rules._touch(bet)
    rules._save_meta(bet)
    if bet.get("noVote") and bet["kind"] == "bozo" and bet["status"] == "VOTING":
        rules.skip_vote(bet)
        slack.new_bozo(bet, _players())
    return _present(req, bet)


@route("PUT", "/api/admin/bets/{betId}/legs/{playerId}", "admin")
def admin_set_leg(req):
    bet = _bundle(req.params["betId"])
    was_complete = len(rules.counted_legs(bet)) >= len([p for p in _players().values() if p.get("active")])
    leg = rules.upsert_leg(bet, req.params["playerId"], req.body, req.body.get("source", "admin"), admin=True)
    if bet["status"] == "OPEN":
        _notify_leg(bet, leg, was_complete)
    return _present(req, bet)


@route("DELETE", "/api/admin/bets/{betId}/legs/{playerId}", "admin")
def admin_delete_leg(req):
    db.delete_leg(req.params["betId"], req.params["playerId"])
    return _present(req, _bundle(req.params["betId"]))


@route("POST", "/api/admin/bets/{betId}/slip-upload", "admin")
def admin_slip_upload(req):
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "heic"}.get(req.body.get("contentType"), "jpg")
    key = f"slips/{req.params['betId']}/{new_id('slip')}.{ext}"
    url = boto3.client("s3").generate_presigned_url(
        "put_object", Params={"Bucket": os.environ["SLIP_BUCKET"], "Key": key, "ContentType": req.body.get("contentType", "image/jpeg")},
        ExpiresIn=600)
    return {"uploadUrl": url, "key": key}


@route("POST", "/api/admin/bets/{betId}/slip-extract", "admin")
def admin_slip_extract(req):
    bet = _bundle(req.params["betId"])
    key = req.body["key"]
    fmt = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "webp": "webp"}.get(key.rsplit(".", 1)[-1])
    if not fmt:
        raise ApiError(400, "Use a PNG, JPEG or WebP image")
    img = boto3.client("s3").get_object(Bucket=os.environ["SLIP_BUCKET"], Key=key)["Body"].read()
    return llm.extract_slip(img, fmt, rules.counted_legs(bet))


@route("POST", "/api/admin/bets/{betId}/lock", "admin")
def admin_lock(req):
    b = req.body
    bet = _bundle(req.params["betId"])
    first = bet["status"] == "OPEN"
    rules.lock(bet, b.get("slipKey"), b.get("totalOdds"), b.get("legOdds"), b.get("sgpGroups"))
    if b.get("wager"):
        bet["wager"] = b["wager"]
    if b.get("toWin"):
        bet["toWin"] = b["toWin"]
    if first:
        bet["slack"] = {**(bet.get("slack") or {}), "lockTs": slack.slip_locked(bet, _players())}
    rules._save_meta(bet)
    _start_tracker(bet["id"], "slip locked")
    return _present(req, bet)


def _start_tracker(bet_id, reason):
    boto3.client("lambda").invoke(FunctionName="bozo-bet-tracker", InvocationType="Event",
                                  Payload=json.dumps({"betId": bet_id, "reason": reason}).encode())


@route("POST", "/api/admin/bets/{betId}/track", "admin")
def admin_track(req):
    _start_tracker(req.params["betId"], "manual")
    return {"started": True}


@route("POST", "/api/admin/bets/{betId}/settle", "admin")
def admin_settle(req):
    bet = _bundle(req.params["betId"])
    for pid, result in (req.body.get("results") or {}).items():
        rules.upsert_leg(bet, pid, {"result": result}, "admin", admin=True)
    outcome = rules.settle(bet, req.body.get("nextWager") or db.get_settings()["defaultWager"], req.body.get("payout"))
    scouting.kick(f"bet {bet['id']} settled")
    players = _players()
    if outcome == "vote":
        commentary.attach(bet, players)
    if bet["kind"] == "bozo":
        (slack.voting_open if outcome == "vote" else slack.new_bozo)(bet, players)
    else:
        slack.side_result(bet, players)
    return _present(req, bet)


@route("POST", "/api/admin/bets/{betId}/reload", "admin")
def admin_reload(req):
    old = _bundle(req.params["betId"])
    new = rules.reload(old, req.body.get("playerId"), req.body.get("wager") or db.get_settings()["defaultWager"],
                       req.body.get("date") or today_ct())
    if old["kind"] == "side":
        slack.reloaded(old, new, _players())
    else:
        scouting.kick(f"bet {old['id']} reloaded")  # its won/lost legs count now
        slack.new_bozo(old, _players())
    return _present(req, new)


@route("POST", "/public/slack/events")
def slack_events(req):
    """Slack Events API (reactions on leg posts). Signed by Slack, so no login."""
    if not reactions.verify(req.headers, req.raw):
        raise ApiError(401, "bad signature")
    return reactions.handle(req.body)


@route("POST", "/api/admin/reactions/sync", "admin")
def admin_reactions_sync(req):
    added, removed = reactions.sync()
    return {"added": added, "removed": removed}


@route("POST", "/api/admin/emoji", "admin")
def admin_emoji(req):
    """Admin's call on an emoji the bot didn't know: up / down / neutral."""
    name, kind = req.body.get("name"), req.body.get("kind")
    if not name or kind not in (reactions.UP, reactions.DOWN, reactions.NEUTRAL):
        raise ApiError(400, "Need an emoji name and up, down or neutral")
    s = db.get_settings()
    s["emojiKinds"] = {**(s.get("emojiKinds") or {}), name: kind}
    db.put_settings(s)
    return {"ok": True}


@route("POST", "/api/admin/scouting", "admin")
def admin_scouting(req):
    scouting.kick("manual")
    return {"started": True}


@route("POST", "/api/admin/slack-test", "admin")
def admin_slack_test(req):
    s = db.get_settings()
    return {"main": bool(slack.main(":wave: Bozo Bet test post. If you can read this, the bot works.", s)),
            "ops": bool(slack.ops(":satellite: Ops channel test post.", s))}


@route("POST", "/api/admin/bets/{betId}/ballot", "admin")
def admin_ballot(req):
    """Rewrite the ballot commentary (or create it for a vote that opened before ballots existed)."""
    bet = _bundle(req.params["betId"])
    if not bet.get("candidates"):
        raise ApiError(409, "No vote on this bet")
    commentary.attach(bet, _players())
    return _present(req, bet)


@route("POST", "/api/admin/bets/{betId}/close-vote", "admin")
def admin_close_vote(req):
    bet = rules.close_vote(_bundle(req.params["betId"]), req.body.get("choice"))
    slack.vote_results(bet, _players())
    return _present(req, bet)


OPEN_CHECKS = ("mismatch", "ambiguous", "unresolved", "review")


@route("GET", "/api/admin/checks", "admin")
def admin_checks(req):
    try:
        reactions.sync()  # catch anything the Events API missed before listing mystery emojis
    except Exception:
        log.exception("reaction sync failed")
    items = []
    for b in db.all_data():
        for l in rules.counted_legs(b):
            c = l.get("check") or {}
            if c.get("status") in OPEN_CHECKS:
                items.append({"betId": b["id"], "date": b["date"], "kind": b["kind"], "title": b.get("title"),
                              "playerId": l["playerId"], "text": l["text"], "odds": l.get("odds"), "result": l.get("result"),
                              "check": c, "game": (l.get("enrichment") or {}).get("game")})
    order = {s: i for i, s in enumerate(OPEN_CHECKS)}
    items.sort(key=lambda x: (order[x["check"]["status"]], x["date"]), reverse=False)
    return {"items": items, "emojis": _unknown_emojis(req.kinds), "players": views.players(db.list_players(), True)}


def _unknown_emojis(kinds):
    """Emojis people reacted with that nobody has classified yet, with where they were used."""
    out = {}
    for b in db.all_data():
        for l in b["legs"]:
            for name, users in (l.get("reactions") or {}).items():
                if name not in kinds:
                    e = out.setdefault(name, {"name": name, "count": 0, "examples": []})
                    e["count"] += len(users)
                    if len(e["examples"]) < 3:
                        e["examples"].append({"betId": b["id"], "playerId": l["playerId"], "text": l["text"], "result": l.get("result")})
    urls = slack.custom_emoji() if out else {}
    for e in out.values():
        e["url"] = urls.get(e["name"])
    return sorted(out.values(), key=lambda e: -e["count"])


@route("POST", "/api/admin/checks/{betId}/{playerId}", "admin")
def admin_resolve_check(req):
    """keep = recorded result stands; espn = take ESPN's; set = admin's own W/L/P.
    Changing a closed bet's leg updates stats only; who was bozo stays as it happened."""
    bet = _bundle(req.params["betId"])
    leg = next((l for l in bet["legs"] if l["playerId"] == req.params["playerId"]), None)
    if not leg or not leg.get("check"):
        raise ApiError(404, "Nothing to check here")
    action = req.body.get("action")
    if action == "keep":
        leg["check"]["status"] = "dismissed"
    elif action in ("espn", "set"):
        result = leg["check"].get("espnResult") if action == "espn" else req.body.get("result")
        if result not in rules.RESULTS:
            raise ApiError(400, "Need a W, L or P")
        leg["check"].update(status="fixed", previous=leg.get("result"))
        leg["result"], leg["resultSource"] = result, "admin"
    else:
        raise ApiError(400, "action must be keep, espn or set")
    leg["check"].update(by=req.user.get("email"), resolvedAt=now_iso())
    db.put_leg(bet, leg)
    return {"ok": True}


@route("POST", "/api/admin/slack-extract", "admin")
def admin_slack_extract(req):
    players = db.list_players()
    roster = [p["name"] + (f" (Slack: {', '.join(p['slackNames'])})" if p.get("slackNames") else "") for p in players if p.get("active")]
    out = llm.extract_slack(req.body.get("conversation", ""), roster)
    by_name = {p["name"].lower(): p["id"] for p in players}
    aliases = {a.lower(): p["id"] for p in players for a in p.get("slackNames", [])}
    for leg in out["legs"]:
        handle = (leg.get("slackName") or "").strip().lstrip("@").lower()
        # The saved Slack names are facts; the model's guess at the bettor is only a fallback
        leg["playerId"] = aliases.get(handle) or by_name.get(handle) or by_name.get((leg.get("bettor") or "").lower())
    return out


@route("GET", "/api/admin/settings", "admin")
def admin_get_settings(req):
    return db.get_settings()


@route("PUT", "/api/admin/settings", "admin")
def admin_put_settings(req):
    current = db.get_settings()
    s = {k: req.body.get(k, current[k]) for k in db.DEFAULT_SETTINGS}  # also drops retired keys (old webhooks)
    db.put_settings(s)
    return s


@route("GET", "/api/admin/users", "admin")
def admin_users(req):
    return {"users": db.list_users(), "players": views.players(db.list_players(), True)}


@route("PUT", "/api/admin/users/{sub}", "admin")
def admin_update_user(req):
    u = db.get_user(req.params["sub"])
    if not u:
        raise ApiError(404, "No such user")
    role = req.body.get("role", u.get("role"))
    if role not in ("none", "viewer", "player", "admin"):
        raise ApiError(400, "Bad role")
    u["role"] = role
    u["playerId"] = req.body.get("playerId", u.get("playerId")) if role in ("player", "admin") else None
    if role == "player" and not u["playerId"]:
        raise ApiError(400, "Players need a linked bozo")
    db.put_user({k: v for k, v in u.items() if v is not None})
    return u


@route("PUT", "/api/admin/players/{playerId}", "admin")
def admin_put_player(req):
    p = db.get_player(req.params["playerId"]) or {"id": req.params["playerId"],
                                                   "slot": max([x["slot"] for x in db.list_players()] + [0]) + 1}
    for k in ("name", "color", "avatar", "active", "pseudonym", "favoriteTeams", "slackNames", "roastLevel"):
        if k in req.body:
            p[k] = req.body[k]
    if not p.get("name"):
        raise ApiError(400, "Players need a name")
    db.put_player(p)
    return views.player(p, True)


@route("POST", "/api/admin/pseudonyms/reroll", "admin")
def admin_reroll(req):
    from . import pseudo
    return {"names": pseudo.regenerate(only=req.body.get("playerIds"))}


# ---------------- dispatch ----------------
def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")
    try:
        for m, rx, role, fn in ROUTES:
            match = rx.match(path)
            if m == method and match:
                user = auth.resolve(event)
                auth.require(user, role)
                return response(200, fn(Req(event, user, match.groupdict())))
        raise ApiError(404, f"No route {method} {path}")
    except ApiError as e:
        return response(e.status, {"error": e.message})
    except Exception as e:
        log.exception("unhandled")
        slack.ops_error(f"API {method} {path}", e)
        return response(500, {"error": "Something broke. Probably the bozo's fault."})
