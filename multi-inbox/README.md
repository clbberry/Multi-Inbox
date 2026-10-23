# Multi Inbox

One inbox for every Gmail account connected to your Composio project. Combined inbox, drafts and spam views; send, reply, delete, mark read/unread; per-account colour and filtering.

## Run locally
```
npm install
cp .env.example .env   # fill in COMPOSIO_API_KEY and APP_PASSWORD
node --env-file=.env server.js
```

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. Railway: New Project, Deploy from GitHub repo.
3. Add variables `COMPOSIO_API_KEY` and `APP_PASSWORD` (Railway sets `PORT` itself).
4. Generate a public domain. Sign in with `APP_PASSWORD`.

## Adding accounts
Connect each Gmail in Composio (dashboard, Connected Accounts, Gmail). The app lists every ACTIVE Gmail connection on your API key and refreshes that list every 5 minutes (Refresh button forces it). No code changes per account.

## Sending identity
Each account's Gmail send-as list (display name, aliases, signature) is read through Composio. The From dropdown offers every alias, replies stay in their thread, and the account signature is appended. Gmail filters and labels act on incoming mail only, so they are applied by Gmail itself, not by this app.

## First-run check
Composio tool schemas change between versions. Open `/api/diagnostics` while signed in: any non-empty `unknownArgs` means that argument name in `composio.js` (the `TOOLS` table) needs updating. Once everything works, set `COMPOSIO_TOOLKIT_VERSION` to a pinned version.

## Security
The app exposes your mail, so it sits behind one shared password (rate-limited, signed HttpOnly cookie). Use a long passphrase and keep it on HTTPS (Railway does).
