"""American-odds math. Everything money-related is computed here, never by an LLM."""
import re

_ODDS_RE = re.compile(r"([+-]?\d+(?:\.\d+)?)")


def parse_american(raw):
    """'(-148)', '+125', '(SGP-118)', -110 -> (int odds | None, is_sgp)."""
    if raw is None or raw == "":
        return None, False
    if isinstance(raw, (int, float)):
        return int(raw), False
    s = str(raw).strip()
    sgp = "SGP" in s.upper()
    m = _ODDS_RE.search(s.replace(" ", ""))
    if not m:
        return None, sgp
    val = float(m.group(1))
    if -100 < val < 100:  # "100" written as e.g. "+100" is fine; anything else in (-100,100) is junk
        return (100 if abs(val) == 100 else None), sgp
    return int(round(val)), sgp


def to_decimal(american):
    if american is None:
        return None
    a = float(american)
    return 1 + (a / 100 if a > 0 else 100 / abs(a))


def implied_prob(american):
    d = to_decimal(american)
    return 1 / d if d else None


def to_american(decimal_odds):
    if not decimal_odds or decimal_odds <= 1:
        return None
    if decimal_odds >= 2:
        return int(round((decimal_odds - 1) * 100))
    return int(round(-100 / (decimal_odds - 1)))


def parlay_decimal(odds_list):
    """Product of decimal odds; None entries (unknown odds) make the result None."""
    d = 1.0
    for o in odds_list:
        x = to_decimal(o)
        if x is None:
            return None
        d *= x
    return d


def flat_bet_units(american, result):
    """Profit in units if this leg had been a 1-unit straight bet."""
    if result == "W":
        d = to_decimal(american)
        return (d - 1) if d else None
    if result == "L":
        return -1.0
    return 0.0


def split_winnings(payout, next_wager, num_bettors):
    """Hit parlay: the next bet's stake comes off the top, the rest is split evenly."""
    if not payout or not num_bettors:
        return 0.0
    return max(0.0, (float(payout) - float(next_wager or 0)) / num_bettors)
