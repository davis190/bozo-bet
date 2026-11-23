import pytest

from bozo import bets as rules
from bozo import odds, stats
from bozo.util import ApiError


class FakeDb:
    def __init__(self):
        self.bets, self.legs, self.votes = {}, {}, {}

    def list_bets(self):
        return sorted(self.bets.values(), key=lambda b: (b["date"], b["seq"]))

    def put_bet(self, b):
        self.bets[b["id"]] = dict(b)

    def put_leg(self, bet, leg):
        self.legs[(bet["id"], leg["playerId"])] = dict(leg)

    def put_vote(self, bet, v):
        self.votes[(bet["id"], v["voterId"])] = dict(v)


@pytest.fixture
def fake(monkeypatch):
    f = FakeDb()
    for name in ("list_bets", "put_bet", "put_leg", "put_vote"):
        monkeypatch.setattr(rules.db, name, getattr(f, name))
    return f


def _bet_with(legs, bozo="p1"):
    bet = rules.create_bet("bozo", "2026-11-20", 10, bozo_id=bozo)
    for pid, text, o in legs:
        rules.upsert_leg(bet, pid, {"text": text, "odds": o}, "app")
    rules.lock(bet)
    return bet


def test_odds_parsing():
    assert odds.parse_american("(-148)") == (-148, False)
    assert odds.parse_american("(SGP-118)") == (-118, True)
    assert odds.parse_american("(+125)") == (125, False)
    assert odds.parse_american(None) == (None, False)
    assert odds.to_american(odds.parlay_decimal([-110, -110])) == 264


def test_hit_keeps_bozo_and_splits_minus_next_wager(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100), ("p3", "c", -110)])
    for pid, r in (("p1", "W"), ("p2", "W"), ("p3", "P")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    assert rules.settle(bet, next_wager=10) == "hit"
    assert bet["payout"] == 40.0  # push dropped: 10 * 2 * 2
    assert bet["perPerson"] == 10.0  # (40 - 10) / 3
    assert bet["nextBozoId"] == "p1" and bet["status"] == "CLOSED"


def test_single_loser_is_auto_bozo_even_with_a_push(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100), ("p3", "c", 100)])
    for pid, r in (("p1", "W"), ("p2", "L"), ("p3", "P")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    assert rules.settle(bet, 10) == "single"
    assert bet["nextBozoId"] == "p2" and bet["nextBozoMethod"] == "auto"


def test_vote_hidden_until_all_voted_then_auto_closes(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100), ("p3", "c", 100)])
    for pid, r in (("p1", "L"), ("p2", "L"), ("p3", "W")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    assert rules.settle(bet, 10) == "vote"
    with pytest.raises(ApiError):
        rules.cast_vote(bet, "p3", "p3")  # p3 won, not a candidate
    rules.cast_vote(bet, "p1", "p1")  # self-vote allowed
    assert not rules.votes_revealed(bet)
    rules.cast_vote(bet, "p2", "p1")
    rules.cast_vote(bet, "p3", "p2")
    assert bet["status"] == "CLOSED" and bet["nextBozoId"] == "p1"


def test_tie_waits_for_admin(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100)])
    for pid in ("p1", "p2"):
        rules.upsert_leg(bet, pid, {"result": "L"}, "admin", admin=True)
    rules.settle(bet, 10)
    rules.cast_vote(bet, "p1", "p2")
    rules.cast_vote(bet, "p2", "p1")
    assert bet["status"] == "VOTING" and set(bet["tie"]) == {"p1", "p2"}
    rules.close_vote(bet, "p2")
    assert bet["nextBozoId"] == "p2"


def test_reload_carries_legs_and_marks_reload_bozo(fake):
    bet = _bet_with([("p1", "thursday leg", -110), ("p2", "b", 100), ("p3", "c", 100)])
    new = rules.reload(bet, "p1", 10, "2026-11-20")
    assert bet["nextBozoMethod"] == "reload" and bet["nextBozoId"] == "p1"
    assert new["id"] != bet["id"] and new["bozoId"] == "p1" and new["status"] == "OPEN"
    assert {l["playerId"] for l in new["legs"]} == {"p2", "p3"}
    assert [l["playerId"] for l in rules.counted_legs(bet)] == ["p1"]  # carried legs don't double count


def test_floor_warning():
    bet = {"bettingFloor": -115}
    assert rules.floor_warning(bet, -200)
    assert rules.floor_warning(bet, -110) is None
    assert rules.floor_warning(bet, 150) is None


def test_stats_luck_and_bozo_counts(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100)])
    for pid, r in (("p1", "W"), ("p2", "L")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    rules.settle(bet, 10)
    players = [{"id": "p1", "slot": 1}, {"id": "p2", "slot": 2}]
    s = stats.compute([bet], players)
    p1 = next(p for p in s["players"] if p["playerId"] == "p1")
    p2 = next(p for p in s["players"] if p["playerId"] == "p2")
    assert p1["luck"] == 0.5 and p1["units"] == 1.0 and p1["bozoCount"] == 1
    assert p2["autoBozo"] == 1 and p2["soleKiller"] == 1
