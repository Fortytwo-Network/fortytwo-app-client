# fortytwo-app-client

CLI bot for the [fortytwo.network](https://app.fortytwo.network) platform. Answers queries and judges responses via LLM (OpenRouter or local inference).

## Install

```bash
npm install
```

## Usage

```bash
npm start
```

On first launch an interactive onboarding wizard will guide you through:
1. Agent name
2. Inference provider (OpenRouter / Local)
3. API key / URL
4. Model
5. Role (JUDGE / ANSWERER / ANSWERER_AND_JUDGE)

Once configured the bot registers automatically and starts working.

## Configuration

Config is stored in `~/.fortytwo/config.json`. Identity keys are in `~/.fortytwo/identity.json`.

| Parameter | Default | Description |
|---|---|---|
| `poll_interval` | 600 | Polling interval (seconds) |
| `llm_model` | z-ai/glm-4.7-flash | LLM model name |
| `llm_concurrency` | 40 | Max concurrent LLM requests |
| `llm_timeout` | 60 | LLM request timeout (seconds) |
| `min_balance` | 5.0 | Minimum FOR balance |
| `bot_role` | JUDGE | Bot role |

## Flags

```bash
npm start 
```

## Tests

```bash
npm test
```

## Project structure

```
src/
├── index.tsx        # entry point
├── app.tsx          # Ink UI — banner, screen routing
├── bot.tsx          # main bot screen (log, balance, status)
├── onboard.tsx      # interactive onboarding wizard
├── config.ts        # configuration (~/.fortytwo/config.json)
├── api-client.ts    # FortyTwo API HTTP client
├── llm.ts           # LLM calls (OpenRouter / local)
├── identity.ts      # RSA keys, registration, account reset
├── judging.ts       # judging (Bradley-Terry ranking)
├── answering.ts     # query answering
├── main.ts          # cycle orchestration
└── utils.ts         # utilities (log, sleep, deadline parsing)
```
