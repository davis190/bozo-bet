"""Bedrock helpers. The LLM classifies, extracts and jokes; it never computes stats or money."""
import json
import logging
import os

import boto3

from .util import ApiError, today_ct

log = logging.getLogger()
FAST = os.environ.get("FAST_MODEL_ID", "us.anthropic.claude-haiku-5-5")
SMART = os.environ.get("SMART_MODEL_ID", "us.anthropic.claude-sonnet-5-5")

_client = None


def client():
    global _client
    _client = _client or boto3.client("bedrock-runtime")
    return _client


def structured(system, content, schema, model=FAST, max_tokens=2000):
    """Force a single tool call so the answer always parses. `content` is a str or Converse content blocks."""
    if isinstance(content, str):
        content = [{"text": content}]
    try:
        resp = client().converse(
            modelId=model,
            system=[{"text": system}],
            messages=[{"role": "user", "content": content}],
            inferenceConfig={"maxTokens": max_tokens},
            toolConfig={
                "tools": [{"toolSpec": {"name": "respond", "description": "Return the answer", "inputSchema": {"json": schema}}}],
                "toolChoice": {"tool": {"name": "respond"}},
            },
        )
    except client().exceptions.AccessDeniedException as e:
        raise ApiError(503, f"Bedrock isn't available yet: {e}") from e
    for block in resp["output"]["message"]["content"]:
        if "toolUse" in block:
            return block["toolUse"]["input"]
    raise ApiError(502, "Model didn't answer in the expected shape")


def text(system, prompt, model=FAST, max_tokens=800):
    try:
        resp = client().converse(modelId=model, system=[{"text": system}],
                                 messages=[{"role": "user", "content": [{"text": prompt}]}],
                                 inferenceConfig={"maxTokens": max_tokens})
    except client().exceptions.AccessDeniedException as e:
        raise ApiError(503, f"Bedrock isn't available yet: {e}") from e
    return "".join(b.get("text", "") for b in resp["output"]["message"]["content"]).strip()


# ---------- schemas ----------
PARSED_SCHEMA = {
    "type": "object",
    "properties": {
        "sport": {"type": "string", "enum": ["NFL", "NCAAF", "NBA", "NCAAB", "MLB", "NHL", "Golf", "Soccer", "Other"]},
        "market": {"type": "string", "enum": ["ML", "Spread", "Over", "Under", "Prop", "Other"],
                   "description": "ML=moneyline, Spread incl. alt lines, Over/Under incl. player and team props with o/u, Prop=yes/no props like anytime TD"},
        "subject": {"type": "string", "enum": ["Team", "Person", "Game"]},
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


def parse_leg(raw):
    return structured(
        BET_CONTEXT + "Turn a casually typed bet into a structured leg. Never invent odds that weren't given. Today is " + today_ct(),
        f"Leg as typed: {raw}", LEG_SCHEMA)


def extract_slack(conversation, roster):
    schema = {
        "type": "object",
        "properties": {"legs": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "person": {"type": "string", "description": "Exactly as written in the conversation (slack name)"},
                "playerName": {"type": ["string", "null"], "description": "Matching roster name, or null if unsure"},
                **LEG_SCHEMA["properties"],
                "evidence": {"type": "string", "description": "The message the leg came from"},
            },
            "required": ["person", "text", "parsed", "confidence", "evidence"],
        }}},
        "required": ["legs"],
    }
    return structured(
        BET_CONTEXT + "Extract each person's FINAL submitted leg from a pasted Slack conversation. If someone changes their pick, "
        "keep only the last one. Ignore jokes, trash talk and other people's suggestions. Roster: " + ", ".join(roster),
        conversation, schema, max_tokens=4000)


def extract_slip(image_bytes, fmt, legs):
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
    result = structured(sys, content, schema, model=FAST)
    if result.get("confidence", 0) < 0.8:
        log.info("slip extraction low confidence on fast model, retrying with smart model")
        result = structured(sys, content, schema, model=SMART)
    return result


ROAST = {"mild": "Keep it light and friendly.", "spicy": "Roast them, but keep it fun.",
         "no mercy": "Absolutely no mercy (still nothing hateful, sexual, or about real-life sensitive topics)."}


def pseudonyms(players):
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
        "Recent legs per bettor:\n" + lines, schema)
    return {n["id"]: n["name"] for n in out["names"]}
