# HYROX Ticket Monitor

This checks the configured HYROX ticket pages, reads the checkout availability JSON, and stores the last available non-charity, non-adaptive athlete tickets in `monitor.state.json`.

Configured events:

- GoodLife HYROX Toronto | Season 26/27
- HYROX Chiba | Season 26/27, men divisions only
- AirAsia HYROX Seoul, waiting for the official page to expose a ticket page
- HYROX Vancouver, waiting for the official page to expose a ticket page

The monitor retries transient failures, writes issue details to `monitor.log`, records the latest error in `monitor.state.json`, and sends Discord error notifications when Discord is configured.

## Commands

```powershell
npm run dry-run
npm run check:now
npm run check
```

`check:now` always checks. `check` respects `minimumMinutesBetweenChecks` from `monitor.config.json`.

If the first real run for an event sees available tickets, it sends an alert. If no tickets are available, it writes a quiet baseline. Later runs alert only when a new available non-charity, non-adaptive athlete ticket appears. Open Men (`SOLO_OPEN_M`) is marked as priority.

Available tickets are not silently baselined if the cache is missing. When an alert is generated, Discord delivery is required and the monitor saves the new state only after the alert is sent successfully.

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

That workflow runs hourly. GitHub cron schedules are UTC, and a simple hourly schedule keeps Toronto, Chiba, Seoul, and Vancouver covered without mapping separate event time zones. It keeps `monitor.state.json` in the GitHub Actions cache so the workflow can compare each current page against the previous run without committing state files to the repo.

To use Discord in GitHub Actions:

1. Open the GitHub repository.
2. Go to Settings -> Secrets and variables -> Actions.
3. Add a repository secret named `DISCORD_WEBHOOK_URL`.

After a baseline exists for an event, later runs send Discord only when a new available non-charity, non-adaptive athlete ticket appears. Open Men is marked as priority.

If a configured event only has an official HYROX page and no ticket page yet, the monitor checks the official page for a ticket-page link and records a waiting state instead of failing. Once the ticket page appears, later runs use checkout availability JSON for normal ticket alerts.

Pushes to `main` also run the workflow as a sanity check. If a commit message contains `[discord-test]`, the workflow sends a Discord smoke-test message instead of checking tickets.

If the monitor script fails after retries, it sends Discord with the failed stage and GitHub run URL. If the workflow fails before the script can run, the final workflow step sends a separate Discord failure message. Failed workflow runs also upload `.monitor-cache` as a diagnostics artifact when available.
