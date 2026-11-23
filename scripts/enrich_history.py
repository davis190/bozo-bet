"""Backfill game context for every historical leg, and cross-check recorded results against ESPN.

    AWS_PROFILE=... TABLE_NAME=bozo-bet python scripts/enrich_history.py [--limit N] [--force]

For each leg: (1) fill missing sport/market/subject with the leg parser, (2) resolve it to a game with
the tracker agent, (3) evaluate the final box score, (4) derive enrichment. Writes leg.track and
leg.enrichment. Never changes a recorded result; disagreements go to scripts/out/mismatches.json.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from bozo import bets as rules  # noqa: E402
from bozo import db, enrich, games, llm, tracker  # noqa: E402

usage = {"in": 0, "out": 0}


def _hook(model, u, _ms):
    usage["in"] += u.get("inputTokens", 0)
    usage["out"] += u.get("outputTokens", 0)


def _check(leg, status, note=None, espn=None):
    """Record what needs a human. Never overrides an admin's earlier decision."""
    if (leg.get("check") or {}).get("status") in ("dismissed", "fixed"):
        return
    if status == "ok":
        leg.pop("check", None)
    else:
        leg["check"] = {"status": status, "note": (note or "")[:300], "espnResult": espn, "at": tracker.now_iso()}


def one(bet, leg):
    try:
        if not (leg.get("parsed") or {}).get("sport"):
            p = llm.parse_leg(leg["text"]).get("parsed") or {}
            leg["parsed"] = {k: p[k] for k in ("sport", "market", "subject") if p.get(k)}
        cache = {}
        spec = {**tracker.resolve(leg, bet["date"], cache), "resolvedAt": tracker.now_iso()}
        leg["track"] = spec
        if not spec.get("found"):
            _check(leg, "unresolved", spec.get("reason"))
            db.put_leg(bet, leg)
            return ("unresolved", bet, leg, spec.get("reason"))
        s = games.summary(spec["league"], spec["eventId"], cache)
        live = tracker.evaluate(spec, s)
        leg["enrichment"] = enrich.derive({"sport": leg["parsed"].get("sport"), **spec}, s, live)
        got, kind, note = live.get("result"), "ok", None
        if live.get("needsReview"):
            kind, note = "review", live.get("detail")
        elif got and leg.get("result") and got != leg["result"]:
            note = f"recorded {leg['result']}, ESPN says {got}: {live.get('detail')} ({s.get('name') or ' vs '.join(t['abbr'] for t in s['teams'])}, {(s.get('start') or '')[:10]})"
            # another game in the series agreeing with the sheet means we likely picked the wrong game, not a sheet error
            others = [i for i in spec.get("candidateEventIds") or [] if i != spec["eventId"]]
            agree = [i for i in others if tracker.evaluate(spec, games.summary(spec["league"], i, cache)).get("result") == leg["result"]]
            kind = "ambiguous" if agree or spec.get("ambiguous") else "mismatch"
        _check(leg, kind, note, got)
        db.put_leg(bet, leg)
        return (kind, bet, leg, note)
    except Exception as e:
        return ("error", bet, leg, f"{type(e).__name__}: {str(e)[:150]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="re-enrich legs that already have enrichment")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--from-report", action="store_true", help="only redo legs the last report flagged (mismatch/unresolved/error)")
    a = ap.parse_args()
    llm.usage_hook = _hook
    jobs = [(b, l) for b in db.all_data() if b["status"] == "CLOSED"
            for l in rules.counted_legs(b) if a.force or not l.get("enrichment")]
    if a.from_report:
        prev = json.loads((Path(__file__).parent / "out" / "enrich_report.json").read_text())
        flagged = {(x["bet"], x["player"]) for k in ("mismatch", "ambiguous", "unresolved", "review", "error") for x in prev.get(k, [])}
        jobs = [(b, l) for b in db.all_data() if b["status"] == "CLOSED"
                for l in rules.counted_legs(b) if (b["id"], l["playerId"]) in flagged]
    jobs = jobs[: a.limit or None]
    print(f"{len(jobs)} legs to enrich", flush=True)
    results = []
    with ThreadPoolExecutor(a.workers) as ex:
        for i, r in enumerate(ex.map(lambda j: one(*j), jobs), 1):
            results.append(r)
            if i % 25 == 0:
                print(f"  {i}/{len(jobs)}", flush=True)
    by = {}
    for kind, b, l, note in results:
        by.setdefault(kind, []).append({"bet": b["id"], "player": l["playerId"], "leg": l["text"], "note": note})
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    (out / "enrich_report.json").write_text(json.dumps(by, indent=1))
    cost = usage["in"] / 1e6 * 1.0 + usage["out"] / 1e6 * 5.0
    print({k: len(v) for k, v in by.items()}, f"~${cost:.2f} (Haiku)")
    print(f"report: {out / 'enrich_report.json'}")


if __name__ == "__main__":
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    main()
