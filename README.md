# HYROX Ticket Monitor

This checks the configured HYROX ticket pages, reads the checkout availability JSON, and stores the last available non-charity athlete tickets in `monitor.state.json`.

Configured events:

- GoodLife HYROX Toronto | Season 26/27
- HYROX Chiba | Season 26/27

The monitor retries transient failures, writes issue details to `monitor.log`, records the latest error in `monitor.state.json`, and sends Discord error notifications when Discord is configured.

## Commands

```powershell
npm run dry-run
npm run check:now
npm run check
```

`check:now` always checks. `check` respects `minimumMinutesBetweenChecks` from `monitor.config.json`.

The first real run for each event writes a baseline and does not send an alert. Later runs alert only when a new available non-charity athlete ticket appears. Open Men (`SOLO_OPEN_M`) is marked as priority.

## Discord

1. Copy `.env.example` to `.env`.
2. Put your Discord webhook URL in `.env`.
3. Set `notifications.discord.enabled` to `true` in `monitor.config.json`.
4. Test it:

```powershell
npm run notify-test
```

## Scheduling

For Windows Task Scheduler, run this command from this folder:

```powershell
npm run check
```

Use every 45-60 minutes when actively watching for returned tickets. Twice daily is fine as a quieter baseline, but may miss short-lived drops.

## GitHub Actions

The repository includes `.github/workflows/hyrox-ticket-monitor.yml`.

That workflow runs hourly. GitHub cron schedules are UTC, and a simple hourly schedule keeps both Toronto and Chiba covered without mapping separate event time zones. It keeps `monitor.state.json` in the GitHub Actions cache so the workflow can compare each current page against the previous run without committing state files to the repo.

To use Discord in GitHub Actions:

1. Open the GitHub repository.
2. Go to Settings -> Secrets and variables -> Actions.
3. Add a repository secret named `DISCORD_WEBHOOK_URL`.

After the first run for an event writes its baseline, later runs send Discord only when a new available non-charity athlete ticket appears. Open Men is marked as priority.

Pushes to `main` also run the workflow as a sanity check. If a commit message contains `[discord-test]`, the workflow sends a Discord smoke-test message instead of checking tickets.

If the monitor script fails after retries, it sends Discord with the failed stage and GitHub run URL. If the workflow fails before the script can run, the final workflow step sends a separate Discord failure message. Failed workflow runs also upload `.monitor-cache` as a diagnostics artifact when available.
