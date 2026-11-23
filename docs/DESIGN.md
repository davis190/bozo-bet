# Bozo Bet — Design

## Principles
1. **Code does the math, the LLM tells the jokes.** Odds, records, luck and money are computed in `backend/bozo/stats.py` and `odds.py`. LLMs only classify, extract and write narrative over numbers they are given.
2. **One obvious action per screen.** The home screen always shows what *you* need to do next (submit, vote, sweat).
3. **Unserious by default.** Clown crowns, roasts, bad-beat shame. Each player sets their own roast level.

## Rules
- Each active player submits one leg. The admin uploads a slip photo, which locks the legs; odds are read off the ticket.
- **Settle:**
  - **Hit:** current bozo goes again. Winnings = payout − next wager, split evenly among bettors.
  - **Exactly 1 loser** (pushes don't count): that player is bozo automatically.
  - **2+ losers:** vote. Everyone with a leg votes for a loser (self-votes allowed). Votes stay hidden until all are in, then everything is revealed, including who voted for whom. The admin can close early or break ties.
- **Reload:** an early leg (e.g. Thursday) lost. That player self-proclaims "reload bozo", other legs carry over into a new bet (editable), and the reloader places it.
- **Push:** the leg is dropped from the parlay and the payout is recomputed (admin can override with the casino number). Never eligible for bozo.
- **Betting floor:** optional minimum odds per leg set by the bozo; the app warns, never blocks.
- **Side bets:** same flow, no bozo/vote; whoever pays is tracked.

## Access
| | Public | Logged in (unapproved) | Viewer | Player | Admin |
|---|---|---|---|---|---|
| Current bet, live board | pseudonyms | pseudonyms | names | names | names |
| History, stats, money | – | – | ✓ | ✓ | ✓ |
| Submit leg, vote, profile | – | – | – | ✓ | ✓ |
| Admin console | – | – | – | – | ✓ |

## Data (DynamoDB single table)
See the docstring in `backend/bozo/db.py`. Players carry a fixed slot → fixed color (validated categorical palette) so the group always recognizes each other behind the pseudonyms.

## LLM usage (Bedrock)
| Feature | Model | Status |
|---|---|---|
| Free-text leg → structured leg + "your history says…" nudge | Haiku | built |
| Slack paste → legs (admin reviews) | Haiku | built |
| Slip photo → per-leg odds, totals | Haiku → Sonnet fallback on low confidence | built |
| Weekly pseudonyms (respects roast level, banned words, never real names) | Haiku | built (fallback generator until Bedrock is verified) |
| Historical enrichment (slot, fav/dog, home/road, prop type, margin…) | cheapest model + ESPN data | next |
| Live tracker (green/yellow/red, self-scheduling) | AgentCore + Haiku | next |
| Weekly "Bozo Gazette" roast recap, scouting reports | Sonnet, cached | next |
| Bozo Oracle (ask stats in English, tool-calls only) | Haiku, daily cap | next |

## Stats
Built: record, win% vs implied, **luck** (wins − expected), **flat-bet units**, avg/best odds, bozo counts by method, bozo curse, sole assassin + $ left on table, streaks, near misses, group hit rate vs expected ("curse meter"), splits by sport/market/subject/odds bucket, games-above-.500 race, wall of shame, vote grudge matrix, awards.

Unlocked by enrichment: time slot (TNF/SNF/MNF/early/late window/international/holiday), favorite vs dog, home/road, divisional, dome/outdoor + weather, prop type & position, when the leg was decided, bad-beat margin, homer index.

## Live tracking (next)
Slip lock → find game start times → EventBridge Scheduler one-time `at()` for first kickoff → each run checks legs (free ESPN endpoints / AgentCore web tool), writes `leg.live`, and schedules the next run (default 30 min, shorter near close finishes, capped per day). Runs stop when all games are final. Every on/off/frequency change posts to the Slack logs channel.
