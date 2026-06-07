# Telegram Lead Marketplace Bot

A Telegram bot that functions as a marketplace for selling leads. Clients can browse, filter, and purchase leads. Admins manage leads, clients, top-up requests, and refund disputes.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Telegram bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — from BotFather
- Required env: `ADMIN_IDS` — comma-separated Telegram user IDs with admin access (e.g. `123456789,987654321`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Bot: Telegraf v4 (long polling)
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- File parsing: xlsx (CSV/Excel bulk lead import)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/index.ts` — all Telegram bot logic
- `artifacts/api-server/src/index.ts` — server entry + bot launch
- `lib/db/src/schema/` — DB tables: users, leads, purchases, topupRequests, refundRequests

## Architecture decisions

- Bot runs via long polling inside the same Express process — no webhook needed for dev
- Admin access is controlled via `ADMIN_IDS` env var (comma-separated Telegram user IDs)
- Sessions stored in-memory via Telegraf's built-in `session()` middleware (suitable for single-process)
- Lead contacts only visible after purchase (full info shown post-buy)
- Refund requests require a screenshot (photo) uploaded in Telegram chat

## Product

**For clients:**
- Browse Hot / Cold leads filtered by language and position
- View lead preview (name, language, position, price)
- Purchase leads using wallet balance
- View full lead details + contacts after purchase
- Top-up balance (manual — sends request to admin who confirms)
- Request refund for invalid leads with description + screenshot

**For admins:**
- Upload single lead step-by-step via chat
- Bulk import leads via CSV or Excel file
- View all clients with balance and purchase history
- Manually top-up any client's balance
- Approve/reject client top-up requests
- Approve/reject client refund requests (with screenshot review)

## User preferences

- Language: Ukrainian (bot messages are in Ukrainian)
- Payment: Manual crypto top-up (client requests → admin confirms)

## Gotchas

- After changing DB schema, always run `pnpm --filter @workspace/db run push`
- ADMIN_IDS must be set before first run or the admin menu won't appear
- The bot uses in-memory sessions — if the server restarts, any mid-flow session state is lost
- xlsx package handles both .xlsx, .xls and .csv bulk imports

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
