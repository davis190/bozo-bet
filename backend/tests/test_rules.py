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


def test_llm_schema_repair_and_required():
    from bozo.llm import _validate
    schema = {"type": "object", "required": ["legs"], "properties": {"legs": {"type": "array", "items": {
        "type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}}}}}
    out = {"legs": '[{"text": "Bills ML"}]'}  # cheap models love stringified JSON
    assert _validate(out, schema) == [] and out["legs"][0]["text"] == "Bills ML"
    assert _validate({"legs": [{}]}, schema) == ["$.legs[0].text is required"]


def _game(state, scores, period=None, clock=None, players=None, league="football/nfl"):
    return {"league": league, "id": "1", "state": state, "period": period, "clock": clock, "detail": state,
            "teams": [{"abbr": a, "score": s} for a, s in scores.items()], "players": players or {}}


def test_tracker_evaluate_spreads_totals_props():
    from bozo.tracker import evaluate
    final = _game("post", {"KC": 34, "ARI": 7})
    assert evaluate({"kind": "spread", "team": "KC", "line": -16}, final)["result"] == "W"
    assert evaluate({"kind": "spread", "team": "KC", "line": -27}, final)["result"] == "P"
    assert evaluate({"kind": "moneyline", "team": "ARI"}, final)["result"] == "L"
    assert evaluate({"kind": "game_total", "line": 46, "direction": "over"}, _game("post", {"NYG": 23, "JAX": 18}))["result"] == "L"
    box = {"Josh Allen": {"_team": "BUF", "passing.TD": 1}}
    assert evaluate({"kind": "player_stat", "player": "Josh Allen", "stats": ["passing.TD"], "line": 1.5}, _game("post", {"BUF": 26, "MIA": 9}, players=box))["result"] == "L"
    # an over that's already cleared is won mid-game; an under that's blown is dead
    live = _game("in", {"A": 30, "B": 20}, period=3, clock="5:00")
    assert evaluate({"kind": "game_total", "line": 45.5, "direction": "over"}, live)["status"] == "WON"
    assert evaluate({"kind": "game_total", "line": 45.5, "direction": "under"}, live)["status"] == "LOST"
    # live moneyline up 18 at the half is on pace; down 3 is a sweat
    assert evaluate({"kind": "moneyline", "team": "A"}, _game("in", {"A": 28, "B": 10}, period=2, clock="0:00"))["status"] == "ON_PACE"
    assert evaluate({"kind": "moneyline", "team": "A"}, _game("in", {"A": 17, "B": 20}, period=4, clock="2:00"))["status"] == "IN_DOUBT"


def test_tracker_player_name_matching():
    from bozo.tracker import _find_player
    players = {"Kenneth Walker III": {"x": 1}, "Amon-Ra St. Brown": {"x": 2}}
    assert _find_player(players, "Kenneth Walker") == {"x": 1}
    assert _find_player(players, "Amon-Ra St Brown") == {"x": 2}


def test_tracker_normalize_fixes_known_mismatches():
    from bozo.tracker import normalize
    f = {"found": True, "eventId": "1"}
    assert normalize({**f, "kind": "game_total", "direction": "under", "line": 40.5}, "O40.5 Texans Rams (alt)")["direction"] == "over"
    assert normalize({**f, "kind": "player_stat", "direction": "under", "line": 225}, "Lamar O 225 passing")["direction"] == "over"
    assert normalize({**f, "kind": "player_stat", "direction": "over", "line": 207.5}, "Kyler Murray Under 207.5 Yards")["direction"] == "under"
    td = normalize({**f, "kind": "team_total", "team": "HOU", "line": 2.5}, "Texans O 2.5 TDs")
    assert td["kind"] == "team_stat" and td["stat"] == "TD"
    assert normalize({**f, "kind": "player_stat", "stats": ["passing.TD", "rushing.TD"]}, "Jordan Love 1.5 TD O")["stats"] == ["passing.TD"]
    assert normalize({**f, "kind": "player_stat", "stats": ["rushing.TD", "receiving.TD"]}, "J Allen anytime TD")["stats"] == ["rushing.TD", "receiving.TD"]
    assert normalize({**f, "kind": "moneyline", "league": "soccer/eng.1"}, "Arsenal ML v Brentford")["drawLoses"] is True
    for unsupported in ("Bo Nix 145+ pass yds 1st half", "Liverpool Arsenal both teams to score", "Brewers/cubs total runs even", "Crystal Palace or Tie"):
        assert normalize({**f, "kind": "player_stat"}, unsupported)["found"] is False, unsupported


def test_tracker_counts_touchdowns_not_points():
    from bozo.tracker import evaluate
    g = {**_game("post", {"HOU": 23, "DET": 26}), "scoring": {"HOU": {"TD": 2, "FG": 3}, "DET": {"TD": 3, "FG": 1}}}
    assert evaluate({"kind": "team_stat", "team": "HOU", "stat": "TD", "line": 2.5, "direction": "over"}, g)["result"] == "L"
    assert evaluate({"kind": "game_stat", "stat": "FG", "line": 3.5, "direction": "over"}, g)["result"] == "W"


def test_bozo_droughts():
    bets = [
        {"kind": "bozo", "status": "CLOSED", "date": "2026-10-01", "nextBozoId": "p1", "nextBozoMethod": "voted"},
        {"kind": "bozo", "status": "CLOSED", "date": "2026-10-08", "nextBozoId": "p2", "nextBozoMethod": "auto"},
        {"kind": "bozo", "status": "CLOSED", "date": "2026-10-15", "nextBozoId": "p2", "nextBozoMethod": "voted"},
        {"kind": "side", "status": "CLOSED", "date": "2026-10-16"},
        {"kind": "bozo", "status": "LOCKED", "date": "2026-10-22"},
    ]
    d = rules.bozo_droughts(bets, "2026-10-22")
    assert d["p1"] == {"lastDate": "2026-10-01", "betsSince": 2, "daysSince": 21, "how": "voted"}
    assert d["p2"]["betsSince"] == 0 and "p3" not in d


def test_tracker_normalize_ou_on_moneyline_becomes_total():
    from bozo.tracker import normalize
    out = normalize({"found": True, "eventId": "1", "kind": "spread", "team": "LAR", "line": 40.5}, "O40.5 Texans Rams (alt)")
    assert out["kind"] == "game_total" and out["direction"] == "over"
    assert normalize({"found": True, "kind": "moneyline"}, "Packers ML")["found"] is False  # no game chosen


def test_closing_opens_the_next_bet(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100), ("p3", "c", 100)])
    for pid, r in (("p1", "L"), ("p2", "L"), ("p3", "W")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    rules.settle(bet, 15)
    assert rules.current_bet(fake.list_bets())["id"] == bet["id"]  # still voting, nothing new yet
    for v, c in (("p1", "p2"), ("p2", "p2"), ("p3", "p1")):
        rules.cast_vote(bet, v, c)
    nxt = rules.current_bet(fake.list_bets())
    assert nxt["id"] == bet["nextBetId"] and nxt["status"] == "OPEN"
    assert nxt["bozoId"] == "p2" and nxt["wager"] == 15


def test_lock_dates_the_bet_and_ids_stay_unique(fake, monkeypatch):
    monkeypatch.setattr(rules, "today_ct", lambda: "2026-11-22")
    bet = _bet_with([("p1", "a", 100)])
    assert bet["date"] == "2026-11-22" and bet["id"] == "2026-11-20-1"
    rules.lock(bet)  # re-lock (slip numbers edit) keeps the date
    assert bet["date"] == "2026-11-22"
    side = rules.create_bet("side", "2026-11-22", 5)
    assert side["id"] == "2026-11-22-2"


def test_ballot_is_nameless_shuffled_and_drops_leaky_commentary(fake, monkeypatch):
    from bozo import commentary, llm
    bet = _bet_with([("p1", "Joe Burrow 2+ TD", -150), ("p2", "Bears ML", 180), ("p3", "c", 100)])
    for pid, r in (("p1", "L"), ("p2", "L"), ("p3", "W")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    rules.settle(bet, 10)
    players = {"p1": {"name": "Joe Smith", "pseudonym": "Captain Chalk"}, "p2": {"name": "Devan Q"}, "p3": {"name": "Kurtz"}}
    seen = {}

    def fake_llm(system, prompt, schema, **kw):
        seen["prompt"] = prompt
        return {"takes": [{"label": "Bet A", "headline": "Burrow left it in the tunnel", "take": "Joe Burrow, -150, nothing. Pure chalk."},
                          {"label": "Bet B", "headline": "Classic Devan move", "take": "Bears."}]}
    monkeypatch.setattr(llm, "structured", fake_llm)
    monkeypatch.setattr(commentary.slack, "ops", lambda *a, **k: None)
    ballot = commentary.build(bet, players)
    assert [b["label"] for b in ballot] == ["Bet A", "Bet B"] and {b["playerId"] for b in ballot} == {"p1", "p2"}
    assert "Smith" not in seen["prompt"] and "Devan" not in seen["prompt"] and "Kurtz" not in seen["prompt"]
    by = {b["label"]: b for b in ballot}
    # "Joe" is fine (it's in the bet text) and so is "chalk" (one word of a pseudonym, not the pseudonym)
    assert by["Bet A"].get("headline") == "Burrow left it in the tunnel"
    assert "headline" not in by["Bet B"]  # named a group member -> dropped


def test_vote_grudges_hidden_while_vote_open(fake):
    bet = _bet_with([("p1", "a", 100), ("p2", "b", 100), ("p3", "c", 100)])
    for pid, r in (("p1", "L"), ("p2", "L"), ("p3", "W")):
        rules.upsert_leg(bet, pid, {"result": r}, "admin", admin=True)
    rules.settle(bet, 10)
    rules.cast_vote(bet, "p1", "p2")
    players = [{"id": p, "slot": i} for i, p in enumerate(("p1", "p2", "p3"))]
    assert stats.compute([bet], players)["votes"] == {}
    rules.cast_vote(bet, "p2", "p1")
    rules.cast_vote(bet, "p3", "p2")
    assert stats.compute([bet], players)["votes"] == {"p1": {"p2": 1}, "p2": {"p1": 1}, "p3": {"p2": 1}}
