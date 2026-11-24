"""Slack bot posts (chat.postMessage with the bot token from Secrets Manager).
#main is the group channel; #ops is the admin's channel for tracker runs, errors and housekeeping.
Missing token/channel or Slack being down = log and skip, so nothing in the app ever breaks over Slack."""
import json
import logging
import os
import urllib.parse
import urllib.request

import boto3

from . import db

log = logging.getLogger()
SITE = os.environ.get("SITE_URL", "https://bozobet.claytondavis.dev")
SECRET_ID = os.environ.get("SLACK_SECRET_ID", "bozobet/slack")
OPS_IDENTITY = {"username": "Bozo Ops", "icon_emoji": ":satellite:"}

_token = None


def _bot_token():
    global _token
    if _token is None:
        try:
            _token = json.loads(boto3.client("secretsmanager").get_secret_value(SecretId=SECRET_ID)["SecretString"])["bot_token"]
        except Exception:
            log.exception("no slack token")
            _token = ""
    return _token


def _post(channel, text, thread_ts=None, broadcast=False, **extra):
    """-> message ts, or None when skipped/failed."""
    token = _bot_token()
    if not (channel and token):
        return None
    body = {"channel": channel, "text": text, "unfurl_links": False, **extra}
    if thread_ts:
        body.update(thread_ts=thread_ts, reply_broadcast=broadcast)
    try:
        req = urllib.request.Request("https://slack.com/api/chat.postMessage", data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json; charset=utf-8", "authorization": f"Bearer {token}"})
        out = json.loads(urllib.request.urlopen(req, timeout=5).read())
        if not out.get("ok"):
            log.error("slack post failed: %s", out.get("error"))
            return None
        return out["ts"]
    except Exception:
        log.exception("slack post failed")
        return None


def main(text, settings=None, **kw):
    return _post((settings or db.get_settings()).get("slackChannelMain"), text, **kw)


def ops(text, settings=None, **kw):
    return _post((settings or db.get_settings()).get("slackChannelOps"), text, **OPS_IDENTITY, **kw)


def _name(players, pid):
    p = players.get(pid) or {}
    return p.get("name") or pid


def _odds(o):
    return f"({o:+d})" if isinstance(o, int) else ""


def _fmt_odds(o):
    return f"{o:+d}" if isinstance(o, int) else "?"


def _money(x):
    return f"${x:,.2f}".replace(".00", "") if isinstance(x, (int, float)) else "?"


def _next_open(bet):
    return f"\n:slot_machine: Next bet is open - get your legs in: <{SITE}|Bozo Bet>" if bet.get("nextBetId") else ""


def api(method, **params):
    """GET a Slack Web API method with the bot token -> parsed JSON ({} on failure)."""
    token = _bot_token()
    if not token:
        return {}
    try:
        url = f"https://slack.com/api/{method}?" + urllib.parse.urlencode(params)
        out = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"authorization": f"Bearer {token}"}), timeout=8).read())
        if not out.get("ok"):
            log.error("slack %s failed: %s", method, out.get("error"))
        return out
    except Exception:
        log.exception("slack %s failed", method)
        return {}


def custom_emoji():
    """{name: image url} for the workspace's custom emojis (needs emoji:read; empty without it)."""
    token = _bot_token()
    if not token:
        return {}
    try:
        req = urllib.request.Request("https://slack.com/api/emoji.list", headers={"authorization": f"Bearer {token}"})
        out = json.loads(urllib.request.urlopen(req, timeout=5).read())
        return {k: v for k, v in (out.get("emoji") or {}).items() if v.startswith("http")} if out.get("ok") else {}
    except Exception:
        log.exception("emoji.list failed")
        return {}


# ---------------- #main ----------------
def bet_open(bet, players):
    bozo = _name(players, bet.get("bozoId")) if bet.get("bozoId") else "TBD"
    main(f":slot_machine: *Books are open.* {bozo} is headed to the casino with {_money(bet.get('wager'))}. "
         f"Get your legs in: <{SITE}|Bozo Bet>")


def _side(bet):
    """Side bets run alongside the bozo bet, so their posts say which bet they're about."""
    return f":game_die: *{bet.get('title') or 'Side bet'}* · " if bet.get("kind") == "side" else ""


def leg_submitted(bet, leg, players, count=None, settings=None):
    """Returns the ts: reactions on this post are the group's verdict on the leg."""
    tail = f" _({count[0]}/{count[1]} in)_" if count else ""
    return main(f"{_side(bet)}:memo: *{_name(players, leg['playerId'])}* is in: {leg['text']} {_odds(leg.get('odds'))}{tail}\n"
                "_React to judge it_ :+1: :-1:", settings)


def legs_summary(bet, players, changed=False):
    lines = [f"• *{_name(players, l['playerId'])}*: {l['text']} {_odds(l.get('odds'))}"
             for l in sorted(bet["legs"], key=lambda l: players.get(l["playerId"], {}).get("slot", 99))
             if not l.get("carriedOver")]
    head = ":rotating_light: *Legs changed*" if changed else ":clown_face: *All legs are in*"
    bozo = _name(players, bet.get("bozoId")) if bet.get("bozoId") else "TBD"
    if bet.get("kind") == "side":
        main(f"{_side(bet)}{head}" + (f" - {bozo} is placing it" if bet.get("bozoId") else "") + "\n"
             + "\n".join(lines) + f"\n<{SITE}|Open Bozo Bet>")
        return
    main(f"{head} - {bozo} is headed to the casino\n" + "\n".join(lines) + f"\n<{SITE}|Open Bozo Bet>")


def slip_locked(bet, players):
    """Returns the ts so leg results can thread under it."""
    n = len([l for l in bet.get("legs", []) if not l.get("carriedOver")])
    return main(f"{_side(bet)}:lock: *Slip's in.* {n} legs at {_fmt_odds(bet.get('totalOdds'))}, {_money(bet.get('wager'))} to win "
                f"{_money(bet.get('toWin'))}. Tracker's on it - results land in this thread. <{SITE}|Sweat along>")


def leg_final(bet, leg, players, first_loss=False):
    """Threaded under the slip post; the leg that kills the parlay is also broadcast to the channel."""
    icon = {"W": ":white_check_mark:", "L": ":x:", "P": ":heavy_minus_sign:"}[leg["result"]]
    detail = ((leg.get("live") or {}).get("detail") or "").replace("Final · ", "")
    text = f"{icon} *{_name(players, leg['playerId'])}*: {leg['text']}" + (f" - {detail}" if detail else "")
    if first_loss:
        text = f"{_side(bet)}:skull: *The parlay is dead.*\n{text}"
    main(text, thread_ts=(bet.get("slack") or {}).get("lockTs"), broadcast=first_loss)


def parlay_hit(bet, players):
    main(f":moneybag: *THE PARLAY HIT!* {_fmt_odds(bet.get('totalOdds'))} cashed for {_money(bet.get('payout'))}. "
         f"{_money(bet.get('perPerson'))} each after funding the next bet. "
         f"{_name(players, bet.get('nextBozoId'))} stays bozo." + _next_open(bet),
         thread_ts=(bet.get("slack") or {}).get("lockTs"), broadcast=True)


def side_result(bet, players):
    """A side bet finished. No bozo on the line, so it's just hit or miss."""
    if bet.get("result") == "W":
        text = (f"{_side(bet)}:moneybag: *IT HIT!* {_fmt_odds(bet.get('totalOdds'))} cashed for {_money(bet.get('payout'))}"
                f" - {_money(bet.get('perPerson'))} each.")
    else:
        losers = [_name(players, l["playerId"]) for l in bet.get("legs", []) if l.get("result") == "L"]
        text = f"{_side(bet)}:x: *Missed* ({bet.get('record', '')}). Sunk by {', '.join(losers)}. No bozo on the line, just shame."
    main(text, thread_ts=(bet.get("slack") or {}).get("lockTs"), broadcast=True)


def voting_open(bet, players):
    # Vote on the bet, not the person: no names until the results
    ballot = bet.get("ballot") or [{"label": f"Bet {chr(65 + i)}", "text": l.get("text"), "odds": l.get("odds")}
                                   for i, l in enumerate(l for l in bet.get("legs", []) if l["playerId"] in bet.get("candidates", []))]
    lines = [f"• *{b['label']}*: {b['text']} {_odds(b.get('odds'))}" + (f" - _{b['headline']}_" if b.get("headline") else "") for b in ballot]
    main(":ballot_box_with_ballot: *Worst bet voting is open!*\n" + "\n".join(lines) + f"\nVote here: {SITE}/vote")


def vote_tie(bet, players):
    labels = {b["playerId"]: b["label"] for b in bet.get("ballot") or []}
    tied = " and ".join(f"*{labels.get(c, _name(players, c))}*" for c in bet.get("tie", []))
    main(f":handshake: Everyone's voted and it's a tie between {tied}. The commissioner will break it.")


def vote_results(bet, players):
    by = {}
    for v in bet.get("votes", []):
        by.setdefault(v["candidateId"], []).append(_name(players, v["voterId"]))
    texts = {l["playerId"]: l["text"] for l in bet.get("legs", [])}
    lines = [f"{'🤡' if c == bet['nextBozoId'] else '•'} *{_name(players, c)}* ({texts.get(c, '')}): *{len(vs)}* - {', '.join(vs)}"
             for c, vs in sorted(by.items(), key=lambda x: -len(x[1]))]
    main(f":clown_face: *{_name(players, bet['nextBozoId'])} is the new Bozo!*\n" + "\n".join(lines)
         + f"\n<{SITE}/bets/{bet['id']}|Full results>" + _next_open(bet))


def new_bozo(bet, players):
    if bet.get("nextBozoMethod") == "stays":
        return parlay_hit(bet, players)
    who = _name(players, bet["nextBozoId"])
    if bet.get("nextBozoMethod") == "kept":
        main(f":shrug: *Side bet missed* ({bet.get('record', '')}). No vote on this one - *{who}* stays bozo." + _next_open(bet))
        return
    if bet.get("nextBozoMethod") == "reload":
        text = f":repeat: *{who} reloaded.* Self-proclaimed bozo. Everyone else's legs carried over - change yours if you want: <{SITE}|Bozo Bet>"
    else:
        leg = next((l for l in bet.get("legs", []) if l["playerId"] == bet["nextBozoId"]), {})
        text = f":clown_face: *{who}* is the bozo - the only leg that lost ({leg.get('text', '')}). No vote needed." + _next_open(bet)
    main(text)


# ---------------- #ops ----------------
def ops_error(where, err, settings=None):
    ops(f":rotating_light: *{where}* failed: `{type(err).__name__}: {str(err)[:300]}`", settings)
