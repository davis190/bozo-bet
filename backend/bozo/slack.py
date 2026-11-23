"""Incoming-webhook posts. Missing webhook = silently skip, so nothing breaks before they exist."""
import json
import logging
import os
import urllib.request

from . import db

log = logging.getLogger()
SITE = os.environ.get("SITE_URL", "https://bozobet.claytondavis.dev")


def _post(url, text):
    if not url:
        return False
    try:
        req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(), headers={"content-type": "application/json"})
        urllib.request.urlopen(req, timeout=5).read()
        return True
    except Exception:  # Slack being down must never break the app
        log.exception("slack post failed")
        return False


def main(text, settings=None):
    return _post((settings or db.get_settings()).get("slackWebhookMain"), text)


def logs(text, settings=None):
    return _post((settings or db.get_settings()).get("slackWebhookLogs"), text)


def _name(players, pid):
    p = players.get(pid) or {}
    return p.get("name") or pid


def _odds(o):
    return f"({o:+d})" if isinstance(o, int) else ""


def leg_submitted(bet, leg, players):
    main(f":memo: *{_name(players, leg['playerId'])}* is in: {leg['text']} {_odds(leg.get('odds'))}")


def legs_summary(bet, players, changed=False):
    lines = [f"• *{_name(players, l['playerId'])}*: {l['text']} {_odds(l.get('odds'))}"
             for l in sorted(bet["legs"], key=lambda l: players.get(l["playerId"], {}).get("slot", 99))
             if not l.get("carriedOver")]
    head = ":rotating_light: *Legs changed*" if changed else ":clown_face: *All legs are in*"
    bozo = _name(players, bet.get("bozoId")) if bet.get("bozoId") else "TBD"
    main(f"{head} - {bozo} is headed to the casino\n" + "\n".join(lines) + f"\n<{SITE}|Open Bozo Bet>")


def voting_open(bet, players):
    # Vote on the bet, not the person: no names until the results
    ballot = bet.get("ballot") or [{"label": f"Bet {chr(65 + i)}", "text": l.get("text"), "odds": l.get("odds")}
                                   for i, l in enumerate(l for l in bet.get("legs", []) if l["playerId"] in bet.get("candidates", []))]
    lines = [f"• *{b['label']}*: {b['text']} {_odds(b.get('odds'))}" + (f" - _{b['headline']}_" if b.get("headline") else "") for b in ballot]
    main(":ballot_box_with_ballot: *Worst bet voting is open!*\n" + "\n".join(lines) + f"\nVote here: {SITE}/vote")


def vote_results(bet, players):
    lines = [f"• {_name(players, v['voterId'])} → {_name(players, v['candidateId'])}" for v in bet.get("votes", [])]
    tally = ", ".join(f"{_name(players, c)}: {n}" for c, n in sorted((bet.get("tally") or {}).items(), key=lambda x: -x[1]))
    main(f":clown_face: *{_name(players, bet['nextBozoId'])} is the new Bozo!* ({tally})\n" + "\n".join(lines))


def new_bozo(bet, players):
    how = {"auto": "was the only leg that lost", "stays": "goes again - the parlay HIT :moneybag:",
           "reload": "self-proclaimed (reload)"}.get(bet.get("nextBozoMethod"), "")
    main(f":clown_face: *{_name(players, bet['nextBozoId'])}* is the bozo - {how}")
