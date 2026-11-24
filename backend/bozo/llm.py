"""Bedrock helpers. The LLM classifies, extracts and jokes; it never computes stats or money.

Each task routes to its own model so cheap models handle cheap jobs. Defaults are the eval winners
(see evals/); override per task with the LLM_MODELS env var, e.g. '{"parse": "us.amazon.nova-micro-v1:0"}'.
"""
import json
import logging
import os

import boto3
from botocore.config import Config

from .util import ApiError, today_ct

log = logging.getLogger()

HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SONNET = "global.anthropic.claude-sonnet-4-6"
# Picked from evals/results/2026-11-22.md (accuracy first, then cost). <task>_fallback runs when the
# primary model errors or can't produce valid output twice.
DEFAULT_MODELS = {
    "parse": HAIKU,                      # 0.93; interactive and low-volume, so best-accuracy-per-dollar wins
    "slack": "us.amazon.nova-lite-v1:0",  # 0.99, same as Haiku at 1/21 the cost
    "slack_fallback": HAIKU,
    "slip": HAIKU,                       # 0.99; money is on the line
    "slip_fallback": SONNET,             # 1.00; also used when the first read is low-confidence
    "fun": "qwen.qwen3-next-80b-a3b",    # funniest names in human review, 1/8 Haiku's cost
    "fun_fallback": HAIKU,
    "track": HAIKU,                      # tracker agent: leg -> game/stat spec (tool loop over ESPN)
    "commentary": SONNET,                # ballot color commentary; Haiku flipped over/under and invented game flow
    "commentary_fallback": HAIKU,        # in spot checks. Once a vote, so ~1-2c.
    "scout": SONNET,                     # player scouting reports; picks splits by id, so the numbers stay ours
    "scout_fallback": HAIKU,
    "writer": SONNET,                    # recaps / scouting reports (not yet evaluated)
}
MODELS = {**DEFAULT_MODELS, **json.loads(os.environ.get("LLM_MODELS") or "{}")}

_client = None
usage_hook = None  # evals set this to collect (model, usage, latencyMs) per call


def client():
    global _client
    # New accounts have low Bedrock quotas; back off and retry instead of failing the request
    _client = _client or boto3.client("bedrock-runtime", config=Config(retries={"max_attempts": 8, "mode": "adaptive"}, read_timeout=120))
    return _client


def _converse(**kwargs):
    try:
        resp = client().converse(**kwargs)
    except client().exceptions.AccessDeniedException as e:
        raise ApiError(503, f"Bedrock model unavailable: {e}") from e
    if usage_hook:
        usage_hook(kwargs["modelId"], resp.get("usage", {}), resp.get("metrics", {}).get("latencyMs"))
    return resp


def _tool_input(resp):
    for block in resp["output"]["message"]["content"]:
        if "toolUse" in block:
            return block["toolUse"]["input"]
    return None


def structured(system, content, schema, model=None, max_tokens=2000, task="parse"):
    """Force a single tool call so the answer always parses. `content` is a str or Converse content blocks.
    With no explicit model, a failing primary model falls back to MODELS['<task>_fallback'] if one exists."""
    if model is None:
        fallback = MODELS.get(f"{task}_fallback")
        try:
            return _structured(system, content, schema, MODELS[task], max_tokens)
        except (ApiError, client().exceptions.ModelErrorException) as e:
            if not fallback or getattr(e, "status", 502) == 503:
                raise
            log.warning("structured: %s failed for %s (%s), falling back to %s", MODELS[task], task, e, fallback)
            return _structured(system, content, schema, fallback, max_tokens)
    return _structured(system, content, schema, model, max_tokens)


def _structured(system, content, schema, model, max_tokens):
    if isinstance(content, str):
        content = [{"text": content}]
    tool = {"tools": [{"toolSpec": {"name": "respond", "description": "Return the answer", "inputSchema": {"json": schema}}}]}
    base = dict(modelId=model, messages=[{"role": "user", "content": content}], inferenceConfig={"maxTokens": max_tokens})
    try:
        resp = _converse(system=[{"text": system}], toolConfig={**tool, "toolChoice": {"tool": {"name": "respond"}}}, **base)
    except client().exceptions.ValidationException as e:
        if "tool" not in str(e).lower():
            raise
        # Some models (e.g. Llama) reject forced tool choice; ask nicely instead
        resp = _converse(system=[{"text": system + " Always answer by calling the respond tool."}], toolConfig=tool, **base)
    out = _tool_input(resp)
    problems = _validate(out, schema) if out is not None else ["no tool call"]
    if problems:
        # One retry with the complaint attached; cheap models usually fix themselves
        log.info("structured: %s failed schema (%s), retrying", model, problems[:3])
        fix = [{"text": f"Your previous answer was invalid: {'; '.join(problems[:5])}. Answer again by calling respond with every required field."}]
        try:
            resp = _converse(system=[{"text": system}], toolConfig={**tool, "toolChoice": {"tool": {"name": "respond"}}},
                             **{**base, "messages": [{"role": "user", "content": content + fix}]})
        except client().exceptions.ValidationException:
            resp = _converse(system=[{"text": system + " Always answer by calling the respond tool."}], toolConfig=tool,
                             **{**base, "messages": [{"role": "user", "content": content + fix}]})
        out = _tool_input(resp)
        problems = _validate(out, schema) if out is not None else ["no tool call"]
        if problems:
            raise ApiError(502, f"Model didn't answer in the expected shape: {problems[:3]}")
    return out


def _validate(value, schema, path="$"):
    """Minimal JSON-schema check (required + object/array types) that also repairs
    a common cheap-model habit: returning nested objects/arrays as JSON strings. Mutates in place."""
    problems = []
    t = schema.get("type")
    if t == "object":
        if not isinstance(value, dict):
            return [f"{path} should be an object"]
        for k in schema.get("required", []):
            if value.get(k) in (None, ""):
                problems.append(f"{path}.{k} is required")
        for k, sub in (schema.get("properties") or {}).items():
            if k not in value:
                continue
            if sub.get("type") in ("object", "array") and isinstance(value[k], str):
                try:
                    value[k] = json.loads(value[k])
                except ValueError:
                    pass
            problems += _validate(value[k], sub, f"{path}.{k}")
    elif t == "array":
        if not isinstance(value, list):
            return [f"{path} should be an array"]
        for i, item in enumerate(value):
            if (schema.get("items") or {}).get("type") == "object" and isinstance(item, str):
                try:
                    value[i] = item = json.loads(item)
                except ValueError:
                    pass
            problems += _validate(item, schema.get("items") or {}, f"{path}[{i}]")
    return problems


def text(system, prompt, model=None, max_tokens=800, task="writer"):
    resp = _converse(modelId=model or MODELS[task], system=[{"text": system}],
                     messages=[{"role": "user", "content": [{"text": prompt}]}], inferenceConfig={"maxTokens": max_tokens})
    return "".join(b.get("text", "") for b in resp["output"]["message"]["content"]).strip()


# ---------- schemas ----------
PARSED_SCHEMA = {
    "type": "object",
    "properties": {
        "sport": {"type": "string", "enum": ["NFL", "NCAAF", "NBA", "NCAAB", "MLB", "NHL", "Golf", "Soccer", "Other"]},
        "market": {"type": "string", "enum": ["ML", "Spread", "Over", "Under"],
                   "description": "ML = moneyline (also 'to win'). Spread incl. alt lines and +/- points. Over/Under for any total "
                                  "or prop with o/u, including player props. Yes/no props (anytime TD, to score, 2+ TDs) count as Over."},
        "subject": {"type": "string", "enum": ["Team", "Person", "Game"],
                    "description": "Game = both teams' combined total (e.g. 'GB/CHI O 44'). Team = one team's ML/spread/team total. Person = a player prop."},
        "teams": {"type": "array", "items": {"type": "string"}, "description": "Team abbreviations involved, e.g. GB, CHI"},
        "player": {"type": "string"},
        "stat": {"type": "string", "description": "e.g. pass yds, rec yds, rush yds, receptions, ATD, pass TDs, points"},
        "line": {"type": "number"},
        "side": {"type": "string", "description": "the team/side picked for ML/spread"},
    },
    "required": ["sport", "market", "subject"],
}

LEG_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "Cleaned-up leg text in the group's style, e.g. 'Josh Allen O 1.5 Pass TDs'"},
        "odds": {"type": ["integer", "null"], "description": "American odds if stated"},
        "sgp": {"type": "boolean"},
        "parsed": PARSED_SCHEMA,
        "confidence": {"type": "number"},
    },
    "required": ["text", "parsed", "confidence"],
}

BET_CONTEXT = ("You help run 'Bozo Bet': a group of friends where each person picks one leg of a weekly parlay. "
               "The worst leg's owner (the 'bozo') has to go to the casino and place next week's bet. ")


def parse_leg(raw, model=None):
    return structured(
        BET_CONTEXT + "Turn a casually typed bet into a structured leg. Never invent odds that weren't given. "
        "'N+' means at least N, which is Over N-0.5 (2+ TDs = O 1.5, never O 2). Today is " + today_ct(),
        f"Leg as typed: {raw}", LEG_SCHEMA, model=model, task="parse")


def extract_slack(conversation, roster, model=None):
    schema = {
        "type": "object",
        "properties": {"legs": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "slackName": {"type": "string", "description": "The group member who SUBMITTED this leg, exactly as their name appears on the message header"},
                "bettor": {"type": ["string", "null"], "description": "That group member's name from the roster (never an athlete or team), or null if unsure"},
                **LEG_SCHEMA["properties"],
                "evidence": {"type": "string", "description": "The message the leg came from"},
            },
            "required": ["slackName", "text", "parsed", "confidence", "evidence"],
        }}},
        "required": ["legs"],
    }
    return structured(
        BET_CONTEXT + "Extract each person's FINAL submitted leg from a pasted Slack conversation. If someone changes their pick, "
        "keep only the last one. Ignore jokes, trash talk and other people's suggestions. Exactly one leg per group member. "
        "Keep each leg's wording close to how its owner wrote it. Slack handles in parentheses belong to that member. "
        "Group members (bettors) on the roster: " + ", ".join(roster),
        conversation, schema, max_tokens=4000, model=model, task="slack")


def extract_slip(image_bytes, fmt, legs, model=None, fallback=True):
    """Read a casino/sportsbook ticket photo and match each line to a submitted leg."""
    schema = {
        "type": "object",
        "properties": {
            "totalOdds": {"type": ["integer", "null"]},
            "wager": {"type": ["number", "null"]},
            "toWin": {"type": ["number", "null"], "description": "Total payout (stake + profit) if shown"},
            "legs": {"type": "array", "items": {"type": "object", "properties": {
                "playerId": {"type": ["string", "null"], "description": "id of the submitted leg this ticket line matches"},
                "ticketText": {"type": "string"}, "odds": {"type": ["integer", "null"]},
            }, "required": ["ticketText"]}},
            "confidence": {"type": "number"},
        },
        "required": ["legs", "confidence"],
    }
    submitted = "\n".join(f"- id={l['playerId']}: {l['text']}" for l in legs)
    content = [
        {"image": {"format": fmt, "source": {"bytes": image_bytes}}},
        {"text": f"Submitted legs:\n{submitted}\n\nRead the ticket. Match every ticket line to a submitted leg id and give its American odds."},
    ]
    sys = BET_CONTEXT + "You read sportsbook tickets precisely. Never guess numbers you can't read; use null."
    result = structured(sys, content, schema, model=model, task="slip")
    if fallback and result.get("confidence", 0) < 0.8:
        log.info("slip extraction low confidence, retrying with fallback model")
        result = structured(sys, content, schema, task="slip_fallback")
    return result


ROAST = {"mild": "Keep it light and friendly.", "spicy": "Roast them, but keep it fun.",
         "no mercy": "Absolutely no mercy (still nothing hateful, sexual, or about real-life sensitive topics)."}


def pseudonyms(players, model=None):
    """players: [{id, recent: [leg text + result], roastLevel}] -> {id: name}"""
    schema = {"type": "object", "properties": {"names": {"type": "array", "items": {
        "type": "object", "properties": {"id": {"type": "string"}, "name": {"type": "string"}},
        "required": ["id", "name"]}}}, "required": ["names"]}
    lines = "\n".join(
        f"- id={p['id']} (roast level: {p.get('roastLevel') or 'spicy'}; banned words: {', '.join(p.get('bannedWords') or []) or 'none'}): "
        + "; ".join(p["recent"]) for p in players)
    out = structured(
        BET_CONTEXT + "Invent a funny 2-4 word pseudonym for each bettor based on their recent picks and results "
        "(teams, players, bad beats, chalk habits). These are shown publicly, so never include real first or last names "
        "of the bettors, and keep them unique. Sports puns welcome. Respect each roast level and banned words.",
        "Recent legs per bettor:\n" + lines, schema, model=model, task="fun")
    return {n["id"]: n["name"] for n in out["names"]}
