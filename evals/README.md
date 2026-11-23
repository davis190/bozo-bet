# Model evals

Which Bedrock model should each LLM task use? These evals answer with accuracy, cost and latency on Bozo Bet's real work.

| Task | What's graded | Ground truth |
|---|---|---|
| `parse` | free-text leg → sport / market / subject / odds | 150 legs labeled in the original spreadsheet |
| `slack` | messy Slack thread → each person's *final* leg + odds | 10 synthetic threads (Sonnet-written) built from real weeks; includes changed picks and trash talk |
| `slip` | ticket photo → per-leg odds + parlay odds | 12 rendered tickets (rotated, blurred) from real weeks |
| `fun` | weekly pseudonyms | hard rules (unique, length, banned words) + Sonnet judge for funny |

Fixtures contain leg text and odds only; people are replaced with fake names, so they're safe in a public repo.

```sh
pip install boto3 openpyxl playwright && playwright install chromium
AWS_PROFILE=... python evals/build_fixtures.py "Bozo Parlay Bet Tracker.xlsx" --slips --slack   # only when fixtures need rebuilding
AWS_PROFILE=... python evals/run.py                     # all tasks x all models -> results/<date>.md
AWS_PROFILE=... python evals/run.py --tasks parse --models us.amazon.nova-micro-v1:0 --limit 30
```

Winners go into `DEFAULT_MODELS` in `backend/bozo/llm.py` (or override in prod with the `LlmModels` stack parameter, no code change).

Caveats: the spreadsheet labels are human-entered and a bit inconsistent, so `parse` tops out below 100%. Rendered slips are cleaner than real casino photos; add real photos to `fixtures/slips/` to harden the `slip` task.
