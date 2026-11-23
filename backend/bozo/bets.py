"""Game rules: legs, slip lock, settle, reload, voting.

Bet lifecycle (bozo bets):
  OPEN     collecting legs
  LOCKED   slip uploaded; legs frozen, live tracking runs
  VOTING   2+ losers; everyone with a leg votes for a loser
  CLOSED   nextBozoId decided (hit -> same bozo again, 1 loser -> auto, reload -> reloader, else vote)

Side bets skip VOTING: OPEN -> LOCKED -> CLOSED.
"""
from collections import Counter

from . import db, odds
from .util import ApiError, now_iso

RESULTS = {"W", "L", "P"}


def counted_legs(bet):
    """Legs that count toward this bet (legs carried into a reload count on the reload instead)."""
    return [l for l in bet.get("legs", []) if not l.get("carriedOver")]


def computed_odds(bet):
    """Parlay odds from leg odds, with pushes dropped (standard book behaviour)."""
    legs = [l for l in counted_legs(bet) if l.get("result") != "P"]
    if not legs:
        return None
    d = odds.parlay_decimal([l.get("odds") for l in legs])
    return odds.to_american(d) if d else None


def current_bozo_id(bets):
    for b in reversed(bets):
        if b.get("kind") == "bozo" and b.get("status") == "CLOSED" and b.get("nextBozoId"):
            return b["nextBozoId"]
    return None


def current_bet(bets):
    """Latest bozo bet that isn't closed (there should only ever be one)."""
    open_ = [b for b in bets if b.get("kind") == "bozo" and b.get("status") != "CLOSED"]
    return open_[-1] if open_ else None


def _require(bet, *statuses):
    if bet["status"] not in statuses:
        raise ApiError(409, f"Bet is {bet['status']}; needs to be {' or '.join(statuses)}")


def _touch(bet):
    bet["updatedAt"] = now_iso()


def _save_meta(bet):
    db.put_bet({k: v for k, v in bet.items() if k not in ("legs", "votes")})


def create_bet(kind, date, wager, bozo_id=None, title=None, betting_floor=None, seq=None, existing=None):
    if kind not in ("bozo", "side"):
        raise ApiError(400, "kind must be bozo or side")
    existing = existing if existing is not None else db.list_bets()
    if kind == "bozo" and current_bet(existing):
        raise ApiError(409, "There's already an active bozo bet. Close it first, bozo.")
    same_day = [b for b in existing if b["date"] == date]
    bet = {
        "id": f"{date}-{len(same_day) + 1}" if seq is None else f"{date}-{seq}",
        "date": date,
        "seq": len(same_day) + 1 if seq is None else seq,
        "kind": kind,
        "title": title,
        "status": "OPEN",
        "wager": wager,
        "bettingFloor": betting_floor,
        "bozoId": bozo_id if bozo_id is not None else (current_bozo_id(existing) if kind == "bozo" else None),
        "createdAt": now_iso(),
    }
    _touch(bet)
    _save_meta(bet)
    bet["legs"], bet["votes"] = [], []
    return bet


def upsert_leg(bet, player_id, fields, source, admin=False):
    if not admin:  # admins can correct anything, any time
        _require(bet, "OPEN")
    leg = next((l for l in bet["legs"] if l["playerId"] == player_id), None) or {"playerId": player_id}
    allowed = {"text", "odds", "sgp", "parsed", "result", "live", "notes", "enrichment"} if admin else {"text", "odds", "sgp", "parsed"}
    for k, v in fields.items():
        if k in allowed:
            leg[k] = v
    if "result" in leg and leg["result"] not in RESULTS and leg["result"] is not None:
        raise ApiError(400, "result must be W, L, P or null")
    if not leg.get("text"):
        raise ApiError(400, "A leg needs words. Even bozos can type.")
    leg["source"] = leg.get("source") or source
    leg["updatedAt"] = now_iso()
    leg.setdefault("submittedAt", leg["updatedAt"])
    db.put_leg(bet, leg)
    bet["legs"] = [l for l in bet["legs"] if l["playerId"] != player_id] + [leg]
    return leg


def floor_warning(bet, american):
    floor = bet.get("bettingFloor")
    if floor is None or american is None:
        return None
    # "Floor" = shortest odds allowed: -115 floor means -200 is too chalky; +odds always pass a minus floor.
    if odds.to_decimal(american) < odds.to_decimal(floor):
        return f"Below the betting floor of {floor:+d}. The bozo will judge you."
    return None


def lock(bet, slip_key=None, total_odds=None, leg_odds=None):
    _require(bet, "OPEN", "LOCKED")
    if leg_odds:
        for leg in bet["legs"]:
            if leg["playerId"] in leg_odds and leg_odds[leg["playerId"]] is not None:
                leg["odds"] = leg_odds[leg["playerId"]]
                db.put_leg(bet, leg)
    if slip_key:
        bet["slipKey"] = slip_key
    bet["totalOdds"] = total_odds or computed_odds(bet)
    if bet.get("wager") and bet.get("totalOdds"):
        bet["toWin"] = round(bet["wager"] * odds.to_decimal(bet["totalOdds"]), 2)
    bet["status"] = "LOCKED"
    bet["lockedAt"] = now_iso()
    _touch(bet)
    _save_meta(bet)
    return bet


def settle(bet, next_wager, payout=None):
    """All results in -> decide what happens. Returns the outcome string."""
    _require(bet, "LOCKED")
    legs = counted_legs(bet)
    if any(l.get("result") not in RESULTS for l in legs):
        raise ApiError(409, "Every leg needs a W/L/P before settling")
    losers = [l["playerId"] for l in legs if l["result"] == "L"]
    bet["settledAt"] = now_iso()
    bet["record"] = f"{sum(l['result'] == 'W' for l in legs)}-{len(losers)}-{sum(l['result'] == 'P' for l in legs)}"

    if not losers:
        bet["result"] = "W"
        # Pushes shrink the payout; use the casino number if given, else recompute without pushed legs
        if payout is None and bet.get("wager"):
            d = odds.parlay_decimal([l.get("odds") for l in legs if l["result"] != "P"])
            payout = round(bet["wager"] * d, 2) if d else bet.get("toWin")
        bet["payout"] = payout
        bet["nextWager"] = next_wager
        bet["perPerson"] = round(odds.split_winnings(payout, next_wager, len(legs)), 2)
    else:
        bet["result"] = "L"

    if bet["kind"] == "side":
        bet["outcome"] = "hit" if not losers else "miss"
        bet["status"] = "CLOSED"
    elif not losers:
        bet.update(outcome="hit", nextBozoId=bet.get("bozoId"), nextBozoMethod="stays", status="CLOSED")
    elif len(losers) == 1:
        bet.update(outcome="single", nextBozoId=losers[0], nextBozoMethod="auto", status="CLOSED")
    else:
        bet.update(outcome="vote", candidates=losers, status="VOTING", voteOpenedAt=now_iso())
    _touch(bet)
    _save_meta(bet)
    return bet["outcome"]


def reload(bet, player_id, wager, date):
    """Thursday leg lost -> that player self-proclaims bozo and fires a new parlay.
    Everyone else's legs carry over (and can be edited) on the new bet."""
    if bet["kind"] != "bozo":
        raise ApiError(400, "Only bozo bets reload")
    _require(bet, "LOCKED")
    mine = next((l for l in bet["legs"] if l["playerId"] == player_id), None)
    if not mine:
        raise ApiError(400, "That player has no leg on this bet")
    mine["result"] = "L"
    db.put_leg(bet, mine)
    for leg in bet["legs"]:
        if leg["playerId"] != player_id:
            leg["carriedOver"] = True
            db.put_leg(bet, leg)
    bet.update(status="CLOSED", result="L", outcome="reload", nextBozoId=player_id,
               nextBozoMethod="reload", reloadPlayerId=player_id, settledAt=now_iso(), record="0-1-0")
    _touch(bet)
    _save_meta(bet)  # must be CLOSED before the new bet is created

    new = create_bet("bozo", date, wager, bozo_id=player_id)
    new["reloadOf"] = bet["id"]
    bet["reloadedInto"] = new["id"]
    _save_meta(bet)
    _save_meta(new)
    for leg in bet["legs"]:
        if leg["playerId"] != player_id:
            carried = {k: leg[k] for k in ("playerId", "text", "odds", "sgp", "parsed") if k in leg}
            carried["source"] = "carried"
            upsert_leg(new, leg["playerId"], carried, "carried", admin=True)
    return new


def voters(bet):
    return [l["playerId"] for l in counted_legs(bet)]


def tally(bet):
    return Counter(v["candidateId"] for v in bet.get("votes", []))


def votes_revealed(bet):
    return bet["status"] == "CLOSED" or set(voters(bet)) <= {v["voterId"] for v in bet.get("votes", [])}


def cast_vote(bet, voter_id, candidate_id):
    _require(bet, "VOTING")
    if voter_id not in voters(bet):
        raise ApiError(403, "No leg, no vote")
    if candidate_id not in bet.get("candidates", []):
        raise ApiError(400, "You can only vote for someone whose leg lost")
    if any(v["voterId"] == voter_id for v in bet["votes"]):
        raise ApiError(409, "Already voted. No take-backs.")
    vote = {"voterId": voter_id, "candidateId": candidate_id, "at": now_iso()}
    db.put_vote(bet, vote)
    bet["votes"].append(vote)
    if votes_revealed(bet):
        return close_vote(bet, None, auto=True)
    return bet


def close_vote(bet, choice, auto=False):
    """Everyone voted (auto) or admin closes early. Ties stay open unless admin picks."""
    _require(bet, "VOTING")
    counts = tally(bet)
    top = max(counts.values()) if counts else 0
    leaders = [c for c, n in counts.items() if n == top]
    if choice:
        if choice not in bet["candidates"]:
            raise ApiError(400, "Choice must be a candidate")
        winner = choice
    elif len(leaders) == 1:
        winner = leaders[0]
    else:
        bet["tie"] = leaders or bet["candidates"]
        _touch(bet)
        _save_meta(bet)
        if auto:
            return bet
        raise ApiError(409, "It's a tie - admin has to pick the bozo")
    bet.update(nextBozoId=winner, nextBozoMethod="voted", status="CLOSED", voteClosedAt=now_iso(),
               tally=dict(counts))
    bet.pop("tie", None)
    _touch(bet)
    _save_meta(bet)
    return bet
