"""Score Bedrock models on Bozo Bet's real LLM tasks, with cost and latency.

    AWS_PROFILE=... python evals/run.py                         # every task, every model
    AWS_PROFILE=... python evals/run.py --tasks parse --models us.amazon.nova-micro-v1:0,deepseek.v3.2 --limit 40

Tasks (fixtures built by build_fixtures.py):
  parse  free-text leg -> sport/market/subject/odds, graded against the spreadsheet's own labels
  slack  messy Slack thread -> each person's FINAL leg + odds
  slip   ticket photo -> per-leg odds + parlay odds (vision models only)
  fun    weekly pseudonyms: hard rules + a Sonnet judge for funny
"""
import argparse
import json
import re
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import boto3
from botocore.config import Config

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT), str(ROOT.parent / "backend")]
from bozo import llm  # noqa: E402
from models import JUDGE, MODELS, cost  # noqa: E402

FIX = ROOT / "fixtures"
FAKE = ["Tony", "Big Mike", "Sully", "Dutch", "Moose", "Gus", "Ricky"]

_ctx = threading.local()
_lock = threading.Lock()
USAGE = defaultdict(lambda: {"in": 0, "out": 0, "ms": [], "calls": 0})


def _hook(model, usage, latency):
    key = (getattr(_ctx, "task", "?"), getattr(_ctx, "model", model))
    with _lock:
        u = USAGE[key]
        u["in"] += usage.get("inputTokens", 0)
        u["out"] += usage.get("outputTokens", 0)
        u["calls"] += 1
        if latency:
            u["ms"].append(latency)


def tokens(s):
    return set(re.findall(r"[a-z0-9.]+", (s or "").lower().replace("over", "o").replace("under", "u")))


def similar(a, b):
    ta, tb = tokens(a), tokens(b)
    return len(ta & tb) / max(1, len(ta | tb))


# ---------------- graders ----------------
def grade_parse(case, model):
    out = llm.parse_leg(case["input"], model=model)
    p = out.get("parsed", {})
    want_sport = {"World Hockey": {"NHL", "Other"}}.get(case["sport"], {case["sport"]})
    checks = {"sport": p.get("sport") in want_sport, "market": p.get("market") == case["market"], "subject": p.get("subject") == case["subject"]}
    if case["odds"] is not None:
        checks["odds"] = out.get("odds") == case["odds"]
    return sum(checks.values()) / len(checks), checks


def grade_slack(case, model):
    out = llm.extract_slack(case["conversation"], FAKE, model=model)["legs"]
    got = {}
    for l in out:
        who = l.get("bettor") if l.get("bettor") in FAKE else l.get("slackName")
        got[who] = l
    pairs = [(w, got.get(w["person"])) for w in case["legs"]]
    # word overlap misses "KW3" == "Kenneth Walker III"; let the judge rule on the unclear ones
    unclear = [(w, g) for w, g in pairs if g and similar(g.get("text"), w["text"]) < 0.5]
    same = _equivalent([(w["text"], g.get("text")) for w, g in unclear]) if unclear else []
    judged = {id(w): ok for (w, _), ok in zip(unclear, same)}
    right, odds_right, detail = 0, 0, {}
    for want, g in pairs:
        ok = bool(g) and judged.get(id(want), True)
        right += ok
        odds_right += bool(g) and g.get("odds") == want["odds"]
        detail[want["person"]] = ok
    extra = max(0, len(out) - len(case["legs"]))
    score = (right + odds_right) / (2 * len(case["legs"]) + extra)
    return score, {"legs": right / len(case["legs"]), "odds": odds_right / len(case["legs"]), "extra": extra}


EQUIV_SCHEMA = {"type": "object", "properties": {"same": {"type": "array", "items": {"type": "boolean"}}}, "required": ["same"]}


def _equivalent(pairs):
    task = getattr(_ctx, "task", None)
    _ctx.task = "judge"
    listing = "\n".join(f"{i + 1}. A: {a} | B: {b}" for i, (a, b) in enumerate(pairs))
    out = llm.structured("You compare sports bets. Two bets are the same if they'd be the same ticket line: same team/player, "
                         "same market, same line. Wording, abbreviations, nicknames and odds formatting don't matter.",
                         f"For each pair, is A the same bet as B? Answer with one boolean per pair, in order.\n{listing}",
                         EQUIV_SCHEMA, model=JUDGE)
    _ctx.task = task
    return (out["same"] + [False] * len(pairs))[: len(pairs)]


def grade_slip(case, model):
    img = (FIX / case["slip"]).read_bytes()
    legs = [{"playerId": l["person"], "text": l["text"]} for l in case["legs"]]
    out = llm.extract_slip(img, "png", legs, model=model, fallback=False)
    by_id = {l.get("playerId"): l for l in out.get("legs", [])}
    leg_ok = sum(by_id.get(l["person"], {}).get("odds") == l["odds"] for l in case["legs"])
    total_ok = out.get("totalOdds") == case["slipTotal"]
    return (leg_ok + total_ok) / (len(case["legs"]) + 1), {"legs": leg_ok / len(case["legs"]), "total": total_ok}


JUDGE_SCHEMA = {"type": "object", "properties": {"score": {"type": "integer", "minimum": 1, "maximum": 10}, "why": {"type": "string"}},
                "required": ["score", "why"]}


def grade_fun(case, model):
    names = llm.pseudonyms(case, model=model)
    vals = [names.get(p["id"], "") for p in case]
    rules = {
        "all_named": all(vals),
        "unique": len(set(v.lower() for v in vals)) == len(vals),
        "length": all(1 <= len(v.split()) <= 5 for v in vals),
        "banned": all(not any(w.lower() in names.get(p["id"], "").lower() for w in p.get("bannedWords") or []) for p in case),
    }
    _ctx.task = "judge"
    listing = "\n".join(f"- {names.get(p['id'])} (roast: {p['roastLevel']}) <- recent: {'; '.join(p['recent'][:4])}" for p in case)
    j = llm.structured("You judge comedy for a friends' sports-betting group app. Be a tough grader: 5 is 'fine', 9+ is 'actually made me laugh'.",
                       f"Rate how funny, clever and specific to each person's bets these pseudonyms are:\n{listing}", JUDGE_SCHEMA, model=JUDGE)
    _ctx.task = "fun"
    score = (sum(rules.values()) / len(rules)) * 0.4 + (j["score"] / 10) * 0.6
    return score, {**rules, "judge": j["score"], "names": vals}


TASKS = {
    "parse": (grade_parse, lambda: json.loads((FIX / "legs.json").read_text()), False),
    "slack": (grade_slack, lambda: json.loads((FIX / "slack.json").read_text()), False),
    "slip": (grade_slip, lambda: [w for w in json.loads((FIX / "weeks.json").read_text()) if w.get("slip")], True),
    "fun": (grade_fun, lambda: json.loads((FIX / "pseudo.json").read_text()), False),
}


def run_one(task, model, case):
    _ctx.task, _ctx.model = task, model
    t = time.time()
    try:
        score, detail = TASKS[task][0](case, model)
        return {"score": score, "detail": detail, "s": time.time() - t}
    except Exception as e:  # a model failing a case is a score of 0, not a crash
        return {"score": 0.0, "error": f"{type(e).__name__}: {str(e)[:160]}", "s": time.time() - t}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default=",".join(TASKS))
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args()

    llm._client = boto3.client("bedrock-runtime", region_name="us-east-1",
                               config=Config(retries={"max_attempts": 10, "mode": "adaptive"}, read_timeout=180, max_pool_connections=32))
    llm.usage_hook = _hook
    results = {}
    for task in a.tasks.split(","):
        grader, load, needs_vision = TASKS[task]
        cases = load()[: a.limit or None]
        models = [m for m in a.models.split(",") if not needs_vision or MODELS[m][3]]
        jobs = [(m, i, c) for m in models for i, c in enumerate(cases)]
        print(f"\n== {task}: {len(cases)} cases x {len(models)} models", flush=True)
        with ThreadPoolExecutor(a.workers) as ex:
            outs = list(ex.map(lambda j: (j[0], j[1], run_one(task, j[0], j[2])), jobs))
        for m in models:
            rs = [o for mm, _, o in outs if mm == m]
            u = USAGE[(task, m)]
            results[(task, m)] = {
                "score": sum(r["score"] for r in rs) / len(rs),
                "errors": sum("error" in r for r in rs),
                "firstError": next((r["error"] for r in rs if "error" in r), None),
                "costPerCall": cost(m, u["in"], u["out"]) / max(1, len(rs)),
                "p50ms": sorted(u["ms"])[len(u["ms"]) // 2] if u["ms"] else None,
                "details": [r.get("detail") for r in rs],
            }
            r = results[(task, m)]
            print(f"  {MODELS[m][0]:18} score {r['score']:.3f}  err {r['errors']:2}  ${r['costPerCall'] * 1000:.3f}/1k calls  "
                  f"p50 {r['p50ms']}ms  {r['firstError'] or ''}", flush=True)
    write_report(results)


def recommend(rows):
    """Cheapest model within 2 points of the best score."""
    best = max(r["score"] for _, r in rows)
    ok = [(m, r) for m, r in rows if r["score"] >= best - 0.02]
    return min(ok, key=lambda x: x[1]["costPerCall"])[0]


def write_report(results):
    out_dir = ROOT / "results"
    out_dir.mkdir(exist_ok=True)
    stamp = date.today().isoformat()
    (out_dir / f"{stamp}.json").write_text(json.dumps({f"{t}|{m}": r for (t, m), r in results.items()}, indent=1, default=str))
    lines = [f"# Model eval — {stamp}\n", "Score = task accuracy (0–1). Cost = USD per 1,000 calls at on-demand prices.\n"]
    for task in dict.fromkeys(t for t, _ in results):
        rows = sorted(((m, r) for (t, m), r in results.items() if t == task), key=lambda x: -x[1]["score"])
        lines += [f"\n## {task}\n", f"**Recommended:** {MODELS[recommend(rows)][0]} (cheapest within 2 pts of best)\n",
                  "| Model | Score | Errors | $/1k calls | p50 latency |", "|---|---|---|---|---|"]
        for m, r in rows:
            lines.append(f"| {MODELS[m][0]} | {r['score']:.3f} | {r['errors']} | ${r['costPerCall'] * 1000:.2f} | {r['p50ms'] or '—'} ms |")
    (out_dir / f"{stamp}.md").write_text("\n".join(lines) + "\n")
    print(f"\nreport: {out_dir / f'{stamp}.md'}")


if __name__ == "__main__":
    main()
