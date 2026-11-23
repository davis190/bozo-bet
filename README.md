# 🤡 Bozo Bet

Each friend picks one leg of a parlay. When it loses, the losers get voted on, and the bozo goes to the casino to place next week's bet.

Live at **https://bozobet.claytondavis.dev**

## Layout

| Path | What |
|---|---|
| `frontend/` | React + Vite + TypeScript + Tailwind SPA (mobile-first, PWA) |
| `backend/bozo/` | Python Lambdas: API router (`app.py`), game rules (`bets.py`), stats (`stats.py`), Bedrock (`llm.py`), Slack (`slack.py`), weekly pseudonyms (`pseudo.py`) |
| `template.yaml` | SAM app: DynamoDB, Cognito + Google, HTTP API, CloudFront + S3 |
| `infra/pipeline.yaml` | CodePipeline + CodeBuild (deployed once by hand) |
| `buildspec.yml` | Tests → `sam deploy` → build SPA → sync to S3 |
| `scripts/import_sheet.py` | One-time import from the spreadsheet |
| `docs/DESIGN.md` | Product + technical design |

## Deploy

Every push to `main` deploys via CodePipeline. To bootstrap the pipeline itself:

```sh
aws cloudformation deploy --stack-name bozo-bet-pipeline --template-file infra/pipeline.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides ConnectionArn=<codeconnections arn>
```

## Local dev

```sh
cd frontend && npm i
# copy config.json from the deployed site (or build it from stack outputs) into frontend/public/
VITE_API_TARGET=https://bozobet.claytondavis.dev npm run dev
cd backend && python -m pytest tests
```

## Privacy

Real names live only in DynamoDB and are only returned to approved logged-in users. Everyone else sees weekly pseudonyms. **Never commit the spreadsheet**; it is gitignored.
