# Panini Slack app

This app uses Socket Mode with an explicit public-channel allowlist. It supports either designated-reaction capture or administrator-approved full-channel ingestion. The bot requests `users:read` so provider identities can be reconciled with Notion owners; it does not request email, DMs, private channels, files, user tokens, or write scopes.

## Create and install

1. In Slack app management, choose **Create New App -> From an app manifest** and paste `manifest.yaml`.
2. Install the app to the workspace. Copy the bot token beginning with `xoxb-`. If updating an existing app, reinstall it so Slack grants the newly declared `users:read` scope.
3. Under **Basic Information -> App-Level Tokens**, generate a token with `connections:write`. Copy the app token beginning with `xapp-`.
4. Invite the Panini bot to every public channel that should be eligible for capture.
5. Copy each allowlisted channel ID. Panini ignores every other channel. Reaction mode captures only messages marked with `:panini:` or `:bookmark:`; full-channel mode captures accessible message history and new message events.

## Save credentials and enable the connector

Run this from the Panini checkout. The prompts hide both tokens from terminal output and shell history:

```zsh
read -s "SLACK_APP_TOKEN?Slack app token (xapp-): "; echo
read -s "SLACK_BOT_TOKEN?Slack bot token (xoxb-): "; echo
export SLACK_APP_TOKEN SLACK_BOT_TOKEN
pnpm run setup slack -- --channels C012ABCDEF,C034GHIJKL
unset SLACK_APP_TOKEN SLACK_BOT_TOKEN
docker compose up -d --build app worker
```

Replace the example channel IDs with the public channels invited in step 4. Add `--capture-mode all_messages` for full history, thread-reply, and live-message ingestion; the default is `reaction`. The setup command stores both tokens in `.env` with mode `0600`, enables the Slack connector in the configured Panini YAML file, and never prints either token. Full-channel mode is read-only and does not post to Slack.
