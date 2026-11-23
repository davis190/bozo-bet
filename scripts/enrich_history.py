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


def one(bet, leg):
    try:
        if not (leg.get("parsed") or {}).get("sport"):
            p = llm.parse_leg(leg["text"]).get("parsed") or {}
            leg["parsed"] = {k: p[k] for k in ("sport", "market", "subject") if p.get(k)}
        cache = {}
        spec = {**tracker.resolve(leg, bet["date"], cache), "resolvedAt": tracker.now_iso()}
        leg["track"] = spec
        if not spec.get("found"):
            db.put_leg(bet, leg)
            return ("unresolved", bet, leg, spec.get("reason"))
        s = games.summary(spec["league"], spec["eventId"], cache)
        live = tracker.evaluate(spec, s)
        leg["enrichment"] = enrich.derive({"sport": leg["parsed"].get("sport"), **spec}, s, live)
        db.put_leg(bet, leg)
        got = live.get("result")
        if got and leg.get("result") and got != leg["result"]:
            return ("mismatch", bet, leg, f"recorded {leg['result']}, ESPN says {got}: {live.get('detail')}")
        return ("ok", bet, leg, None)
    except Exception as e:
        return ("error", bet, leg, f"{type(e).__name__}: {str(e)[:150]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="re-enrich legs that already have enrichment")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    llm.usage_hook = _hook
    jobs = [(b, l) for b in db.all_data() if b["status"] == "CLOSED"
            for l in rules.counted_legs(b) if a.force or not l.get("enrichment")]
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
