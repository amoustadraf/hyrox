# HYROX Toronto Ticket Monitor

This checks the HYROX Toronto 2026 ticket page, reads the embedded ticket JSON, and stores the last active non-charity athlete tickets in `monitor.state.json`.

## Commands

```powershell
npm run dry-run
npm run check:now
npm run check
```

`check:now` always checks. `check` respects `minimumMinutesBetweenChecks` from `monitor.config.json`.

The first real run writes a baseline and does not send an alert. Later runs alert only when a new active non-charity athlete ticket appears. Open Men (`SOLO_OPEN_M`) is marked as priority.

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

That workflow runs hourly from about 7:17 AM to 11:17 PM Toronto time during daylight time. GitHub cron schedules are UTC, so the workflow uses UTC cron entries that match the October 2026 event window. It keeps `monitor.state.json` in the GitHub Actions cache so the workflow can compare the current page against the previous run without committing state files to the repo.

To use Discord in GitHub Actions:

1. Open the GitHub repository.
2. Go to Settings -> Secrets and variables -> Actions.
3. Add a repository secret named `DISCORD_WEBHOOK_URL`.

After the first run writes its baseline, later runs send Discord only when a new active non-charity athlete ticket appears. Open Men is marked as priority.
