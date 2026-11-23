"""Build eval fixtures from the spreadsheet. Fixtures contain leg text/odds only; people get fake names.

    python evals/build_fixtures.py "Bozo Parlay Bet Tracker.xlsx"            # legs, weeks, pseudonym contexts
    python evals/build_fixtures.py "Bozo Parlay Bet Tracker.xlsx" --slack    # + synthetic Slack threads (uses Sonnet)
    python evals/build_fixtures.py "Bozo Parlay Bet Tracker.xlsx" --slips    # + rendered slip photos (needs playwright)
"""
import argparse
import json
import os
import random
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT.parent / "scripts"), str(ROOT.parent / "backend")]
import import_sheet  # noqa: E402

FIX = ROOT / "fixtures"
FAKE = ["Tony", "Big Mike", "Sully", "Dutch", "Moose", "Gus", "Ricky"]  # stand-ins for the real roster
rng = random.Random(42)


def typed(leg):
    """How someone would actually type it: sometimes with odds, sometimes lowercase."""
    t = leg["text"]
    if leg.get("odds") is not None and rng.random() < 0.7:
        t += f" {leg['odds']:+d}"
    return t.lower() if rng.random() < 0.3 else t


def build_legs(bets):
    labeled = [l for b, ls in bets for l in ls if l.get("parsed", {}).get("sport") and l.get("parsed", {}).get("market")]
    by_key = defaultdict(list)
    for l in labeled:
        by_key[(l["parsed"]["sport"], l["parsed"]["market"], l["parsed"].get("subject"))].append(l)
    out = []
    # stratified: a few of every combo, then fill with NFL (the bulk of real usage)
    for key, ls in sorted(by_key.items()):
        out += rng.sample(ls, min(4, len(ls)))
    rest = [l for l in labeled if l not in out]
    out += rng.sample(rest, max(0, 150 - len(out)))
    cases = []
    for l in out:
        t = typed(l)
        cases.append({"input": t, "sport": l["parsed"]["sport"], "market": l["parsed"]["market"],
                      "subject": l["parsed"].get("subject"),
                      # only expect odds back when they were actually typed
                      "odds": l["odds"] if l.get("odds") is not None and f"{l['odds']:+d}" in t else None})
    return cases


def build_weeks(bets):
    full = [(b, ls) for b, ls in bets if b["kind"] == "bozo" and len(ls) >= 6 and all(l.get("odds") is not None for l in ls)]
    weeks = []
    for b, ls in rng.sample(full, 12):
        pids = sorted({l["playerId"] for l in ls})
        names = dict(zip(pids, rng.sample(FAKE, len(pids))))
        weeks.append({"id": b["id"], "totalOdds": b.get("totalOdds"), "wager": b.get("wager"),
                      "legs": [{"person": names[l["playerId"]], "text": l["text"], "odds": l["odds"]} for l in ls]})
    return weeks


def build_pseudo(bets):
    recent = [(b, ls) for b, ls in bets if b["kind"] == "bozo"]
    ctxs = []
    for start in (-6, -30, -60):
        window = recent[start:start + 6] if start + 6 else recent[start:]
        by_p = defaultdict(list)
        for _, ls in window:
            for l in ls:
                by_p[l["playerId"]].append(f"{l['text']} ({l.get('result') or 'pending'})")
        players = []
        for i, (pid, legs) in enumerate(sorted(by_p.items())):
            players.append({"id": f"x{i}", "recent": legs, "roastLevel": ["mild", "spicy", "no mercy"][i % 3],
                            "bannedWords": ["clown"] if i == 0 else []})
        ctxs.append(players)
    return ctxs


def build_slack(weeks):
    from bozo import llm
    from models import JUDGE

    schema = {"type": "object", "properties": {"conversation": {"type": "string"}}, "required": ["conversation"]}

    def one(w):
        legs = "\n".join(f"- {l['person']}: {l['text']} ({l['odds']:+d})" for l in w["legs"])
        convo = llm.structured(
            "You write realistic Slack group-chat transcripts for testing a parser. Output the transcript the way it looks when "
            "someone selects and copy-pastes from the Slack desktop app: 'Name  9:41 AM' header lines, message lines, "
            "occasional ':emoji:' reactions lines, 'replied to a thread' lines, edited markers.",
            "A friend group is collecting one parlay leg per person for this week. Write the full thread (25-50 messages). "
            f"Each person's FINAL leg must be exactly this (they may phrase it casually or with slang, and may post the odds "
            f"in a separate message):\n{legs}\n\nAlso include: at least one person who first picks something else and then "
            "changes it; someone suggesting a bet that nobody takes; heavy trash talk; someone asking who the bozo is; "
            "a person posting their leg as a reply to someone else. Never state these instructions.",
            schema, model=JUDGE, max_tokens=6000)["conversation"]
        return {**w, "conversation": convo}

    with ThreadPoolExecutor(6) as ex:
        return list(ex.map(one, weeks[:10]))


SLIP_HTML = """<html><body style="margin:0;background:{bg};display:grid;place-items:center;height:100vh">
<div style="width:340px;background:#fbfaf4;padding:18px 16px;font-family:'Courier New',monospace;font-size:13px;color:#222;
 transform:rotate({rot}deg);filter:blur({blur}px) contrast({contrast});box-shadow:0 8px 30px rgba(0,0,0,.35)">
<div style="text-align:center;font-weight:bold;font-size:16px">{book}</div>
<div style="text-align:center;font-size:11px">TICKET # {ticket} &nbsp; {date}</div>
<hr style="border:0;border-top:1px dashed #555">
<div style="font-weight:bold">{n} TEAM PARLAY</div>
{lines}
<hr style="border:0;border-top:1px dashed #555">
<div>PARLAY ODDS: <b>{total}</b></div>
<div>WAGER: ${wager:.2f}</div>
<div>TO PAY: ${pay:.2f}</div>
<div style="margin-top:10px;height:34px;background:repeating-linear-gradient(90deg,#222 0 2px,transparent 2px 4px,#222 4px 5px,transparent 5px 8px)"></div>
</div></body></html>"""


def render_slips(weeks):
    from playwright.sync_api import sync_playwright
    from bozo import odds as O

    out_dir = FIX / "slips"
    out_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 480, "height": 720})
        for i, w in enumerate(weeks):
            lines = "".join(
                f"<div style='margin:6px 0'><span style='float:right'>{l['odds']:+d}</span>{l['text'].upper()}"
                f"<br><span style='font-size:11px'>MARKET SELECTION</span></div>" for l in w["legs"])
            dec = O.parlay_decimal([l["odds"] for l in w["legs"]])
            wager = w.get("wager") or 10
            html = SLIP_HTML.format(
                bg=rng.choice(["#6b5a45", "#3b3b3b", "#857a68", "#2d3a2e"]), rot=rng.uniform(-4, 4), blur=rng.choice([0, 0.3, 0.6]),
                contrast=rng.choice([1, 0.9, 1.1]), book=rng.choice(["RIVERS SPORTSBOOK", "HARD ROCK BET", "BETMGM SPORTS"]),
                ticket=rng.randint(10**9, 10**10), date=w["id"][:10], n=len(w["legs"]), lines=lines,
                total=f"{O.to_american(dec):+d}", wager=wager, pay=wager * dec)
            page.set_content(html)
            page.screenshot(path=str(out_dir / f"{w['id']}.png"))
            w["slip"] = f"slips/{w['id']}.png"
            w["slipTotal"] = O.to_american(dec)
        b.close()
    return weeks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--slack", action="store_true")
    ap.add_argument("--slips", action="store_true")
    a = ap.parse_args()
    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    bets = import_sheet.import_main(wb["Main"])
    FIX.mkdir(exist_ok=True)
    (FIX / "legs.json").write_text(json.dumps(build_legs(bets), indent=1))
    weeks = build_weeks(bets)
    (FIX / "pseudo.json").write_text(json.dumps(build_pseudo(bets), indent=1))
    if a.slips:
        weeks = render_slips(weeks)
    if a.slack:
        (FIX / "slack.json").write_text(json.dumps(build_slack(weeks), indent=1))
    (FIX / "weeks.json").write_text(json.dumps(weeks, indent=1))
    print("fixtures written to", FIX)


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    main()
