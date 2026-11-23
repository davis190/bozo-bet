"""One-time import of 'Bozo Parlay Bet Tracker.xlsx' into DynamoDB.

    python scripts/import_sheet.py "Bozo Parlay Bet Tracker.xlsx" --dry-run
    AWS_PROFILE=... python scripts/import_sheet.py "Bozo Parlay Bet Tracker.xlsx"

Idempotent: ids are deterministic, so re-running overwrites rather than duplicates.
The spreadsheet holds real names - it is gitignored and must never be committed.
"""
import argparse
import os
import sys
from collections import Counter

import openpyxl

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from bozo import odds  # noqa: E402

# slot order == column order in the sheet; colors/avatars are fixed forever.
# Colors are the validated categorical palette (dark-mode steps), in slot order.
PLAYERS = [
    {"id": "p01", "slot": 1, "name": "Clayton", "color": "#3987e5", "avatar": "🎯", "active": True,
     "favoriteTeams": [{"league": "NFL", "team": "IND"}, {"league": "MLB", "team": "STL"}]},
    {"id": "p02", "slot": 2, "name": "Kurtz", "color": "#d95926", "avatar": "🦬", "active": True,
     "favoriteTeams": [{"league": "NFL", "team": "BUF"}]},
    {"id": "p03", "slot": 3, "name": "Sean", "color": "#199e70", "avatar": "👻", "active": False, "favoriteTeams": []},
    {"id": "p04", "slot": 4, "name": "Chester", "color": "#c98500", "avatar": "🐆", "active": True,
     "favoriteTeams": [{"league": "NFL", "team": "CAR"}]},
    {"id": "p05", "slot": 5, "name": "Joe", "color": "#d55181", "avatar": "🧀", "active": True,
     "favoriteTeams": [{"league": "NFL", "team": "GB"}, {"league": "MLB", "team": "MIL"}]},
    {"id": "p06", "slot": 6, "name": "Devan", "color": "#9085e9", "avatar": "🍺", "active": True,
     "favoriteTeams": [{"league": "NFL", "team": "GB"}, {"league": "MLB", "team": "MIL"}]},
    {"id": "p07", "slot": 7, "name": "Casey", "color": "#e66767", "avatar": "🎲", "active": True,
     "favoriteTeams": [{"league": "NFL", "team": "GB"}, {"league": "MLB", "team": "MIL"}]},
]
SEED_PSEUDONYMS = ["Colts Apologist", "Wide Right Willie", "The Ghost of Bets Past", "Panther Prayer Circle",
                   "Sloppy Lambeau", "Cheesehead Chalk", "Moonshot Mystic"]
BY_NAME = {p["name"]: p["id"] for p in PLAYERS}
MAIN_BLOCK = {"p01": 2, "p02": 9, "p03": 16, "p04": 23, "p05": 30, "p06": 37, "p07": 44}  # 7 cols: bet,odds,dec,sport,cat,type,result
SIDE_BLOCK = {"p01": 2, "p02": 5, "p03": 8, "p04": 11, "p05": 14, "p06": 17, "p07": 20}   # 3 cols: bet,odds,result


def col(letters):
    return openpyxl.utils.column_index_from_string(letters)


def clean(v):
    if v is None:
        return None
    s = str(v).replace("\t", " ").strip()
    return s or None


def pid_of(name):
    name = clean(name)
    return BY_NAME.get(name) if name else None


def money(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else None


def american_total(v):
    # The sheet stores total parlay odds as a bare positive number (e.g. 2983 == +2983)
    return int(v) if isinstance(v, (int, float)) and v else None


def leg(pid, text, raw_odds, result, sport=None, cat=None, typ=None):
    o, sgp = odds.parse_american(raw_odds)
    parsed = {k: v for k, v in (("sport", clean(sport)), ("market", clean(cat)), ("subject", clean(typ))) if v}
    out = {"playerId": pid, "text": clean(text), "odds": o, "result": clean(result), "source": "import"}
    if sgp:
        out["sgp"] = True
    if parsed:
        out["parsed"] = parsed
    return {k: v for k, v in out.items() if v is not None}


def import_main(ws):
    bets, seq = [], Counter()
    last = max(r for r in range(3, ws.max_row + 1) if ws.cell(r, 1).value)
    for r in range(3, last + 1):
        date = ws.cell(r, 1).value.date().isoformat()
        seq[date] += 1
        legs = []
        for pid, c in MAIN_BLOCK.items():
            v = [ws.cell(r, c + i).value for i in range(7)]
            if clean(v[0]):
                legs.append(leg(pid, v[0], v[1], v[6], v[3], v[4], v[5]))
        g = lambda letters: ws.cell(r, col(letters)).value  # noqa: E731
        is_reload = clean(g("BK")) == "RELOAD"
        losers = [l["playerId"] for l in legs if l.get("result") == "L"]
        result = clean(g("BE"))
        complete = all(l.get("result") for l in legs) and r < last
        bozo, nxt = pid_of(g("BH")), pid_of(g("BG"))
        if is_reload:
            method = "reload"
        elif result == "W":
            method = "stays"
        elif len(losers) == 1:
            method = "auto"
        else:
            method = "voted"
        bet = {
            "id": f"{date}-{seq[date]}", "date": date, "seq": seq[date], "kind": "bozo",
            "status": "CLOSED" if complete else "LOCKED",
            "bozoId": bozo, "wager": money(g("BA")), "totalOdds": american_total(g("AZ")), "toWin": money(g("BB")),
            "bettingFloor": odds.parse_american(g("BJ"))[0], "record": clean(g("BD")), "source": "import",
        }
        if complete:
            bet.update(result=result, nextBozoId=nxt, nextBozoMethod=method,
                       outcome={"reload": "reload", "stays": "hit", "auto": "single", "voted": "vote"}[method])
            if result == "W":
                bet.update(payout=bet["toWin"], perPerson=money(g("BC")))
            if is_reload:
                bet["reloadPlayerId"] = nxt
        bets.append((bet, legs))
    # The open week has no wager typed in yet; it carries over from the previous bet
    for i, (b, _) in enumerate(bets):
        if b["wager"] is None and i:
            b["wager"] = bets[i - 1][0]["wager"]
    # link reloads to the bet that replaced them
    for i, (b, _) in enumerate(bets):
        if b.get("outcome") == "reload" and i + 1 < len(bets):
            b["reloadedInto"] = bets[i + 1][0]["id"]
            bets[i + 1][0]["reloadOf"] = b["id"]
    return bets


def import_side(ws):
    bets, seq = [], Counter()
    for r in range(3, ws.max_row + 1):
        head = clean(ws.cell(r, 1).value)
        if not head:
            continue
        date, _, title = head.partition(" - ")
        seq[date] += 1
        legs = []
        for pid, c in SIDE_BLOCK.items():
            text, o, res = (ws.cell(r, c + i).value for i in range(3))
            if clean(text):
                legs.append(leg(pid, text, o, res))
        g = lambda letters: ws.cell(r, col(letters)).value  # noqa: E731
        result = clean(g("AC")) or ("L" if any(l.get("result") == "L" for l in legs) else None)
        bets.append(({
            "id": f"{date}-s{seq[date]}", "date": date, "seq": 50 + seq[date], "kind": "side", "title": title,
            "status": "CLOSED", "result": result, "outcome": "hit" if result == "W" else "miss",
            "wager": money(g("Y")), "totalOdds": american_total(g("X")), "toWin": money(g("Z")),
            "record": clean(g("AB")), "bozoId": pid_of(g("AD")), "source": "import",
        }, legs))
    return bets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--table", default="bozo-bet")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    bets = import_main(wb["Main"]) + import_side(wb["Side Bets"])

    n_legs = sum(len(l) for _, l in bets)
    print(f"{len(bets)} bets ({sum(b['kind'] == 'bozo' for b, _ in bets)} bozo, {sum(b['kind'] == 'side' for b, _ in bets)} side), {n_legs} legs")
    print("methods:", Counter(b.get("nextBozoMethod") for b, _ in bets if b["kind"] == "bozo"))
    print("open:", [(b["id"], b["status"]) for b, _ in bets if b["status"] != "CLOSED"])
    print("missing sport tag:", sum(1 for _, ls in bets for l in ls if "sport" not in l.get("parsed", {})))
    if a.dry_run:
        return

    os.environ["TABLE_NAME"] = a.table
    from bozo import db
    items = []
    for i, p in enumerate(PLAYERS):
        existing = db.get_player(p["id"]) or {}
        items.append(db.player_item({**p, "pseudonym": existing.get("pseudonym") or SEED_PSEUDONYMS[i], "roastLevel": existing.get("roastLevel", "spicy")}))
    for b, legs in bets:
        items.append(db.bet_item({k: v for k, v in b.items() if v is not None}))
        items.extend(db.leg_item(b, l) for l in legs)
    db.batch_put(items)
    print(f"wrote {len(items)} items to {a.table}")


if __name__ == "__main__":
    main()
