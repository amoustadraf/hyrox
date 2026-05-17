const fs = require("node:fs/promises");
const path = require("node:path");

const CONFIG_FILE = path.join(__dirname, "monitor.config.json");
const DOT_ENV_FILE = path.join(__dirname, ".env");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force") || dryRun;
const notifyTest = args.has("--notify-test");

if (args.has("--help")) {
  console.log(`
Usage:
  node monitor.js                 Check if enough time has passed since the last run
  node monitor.js --force          Check now, ignoring the minimum interval
  node monitor.js --dry-run        Check now without writing state or sending Discord
  node monitor.js --notify-test    Send a test Discord notification
`);
  process.exit(0);
}

function getNestedValue(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, object);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePath, fallback) {
  if (!(await exists(filePath))) return fallback;
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, raw, "utf8");
}

async function loadDotEnv() {
  if (!(await exists(DOT_ENV_FILE))) return;
  const raw = await fs.readFile(DOT_ENV_FILE, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function fetchText(url, config) {
  const controller = new AbortController();
  const timeoutMs = (config.monitoring.timeoutSeconds || 30) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": config.monitoring.userAgent || "hyrox-ticket-monitor/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractNextData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  );

  if (!match) {
    throw new Error("Could not find the __NEXT_DATA__ JSON block in the page.");
  }

  return JSON.parse(match[1]);
}

function normalizeTicket(ticket) {
  return {
    id: ticket._id,
    name: ticket.name,
    active: ticket.active === true,
    hidden: ticket.styleOptions?.hiddenInSelectionArea === true,
    isCompetition: ticket.meta?.is_competition,
    competitionClass: ticket.meta?.competition_class_matching_key,
    competitionDayIndex: ticket.meta?.competion_day_idx,
    date: ticket.relevancyDate?.start || null
  };
}

function ticketNameHasAny(ticket, fragments) {
  const name = String(ticket.name || "").toUpperCase();
  return fragments.some((fragment) => name.includes(String(fragment).toUpperCase()));
}

function readBooleanEnv(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

function resolveStateFile(config) {
  const configuredPath = process.env.HYROX_STATE_FILE || config.monitoring.stateFile;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

function isPriorityTicket(ticket, prioritySignals) {
  return prioritySignals.some((signal) => {
    if (signal.competitionClass && ticket.competitionClass !== signal.competitionClass) {
      return false;
    }

    if (signal.nameContains && !ticketNameHasAny(ticket, [signal.nameContains])) {
      return false;
    }

    if (
      signal.nameMustNotContain &&
      ticketNameHasAny(ticket, signal.nameMustNotContain)
    ) {
      return false;
    }

    return true;
  });
}

function filterInterestingTickets(rawTickets, config) {
  const filter = config.ticketFilter;
  const ignoredNames = filter.ignoreNamesContaining || [];
  const excludedClasses = new Set(filter.excludedCompetitionClasses || []);
  const availableField = filter.availableWhen?.field || "active";
  const availableValue = filter.availableWhen?.equals ?? true;

  return rawTickets
    .map(normalizeTicket)
    .filter((ticket) => !ticket.hidden)
    .filter((ticket) => !ticketNameHasAny(ticket, ignoredNames))
    .filter((ticket) => {
      if (!filter.onlyAthleteTickets) return true;
      return getNestedValue({ meta: { is_competition: ticket.isCompetition } }, filter.competitionMetaField) === filter.competitionMetaValue;
    })
    .filter((ticket) => !excludedClasses.has(ticket.competitionClass))
    .filter((ticket) => ticket[availableField] === availableValue)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatTicket(ticket) {
  const date = ticket.date ? ticket.date.slice(0, 10) : "unknown date";
  return `${ticket.name} (${ticket.competitionClass || "unknown class"}, ${date})`;
}

function buildDiscordMessage({ config, event, newTickets, priorityTickets }) {
  const lines = [];
  const discord = config.notifications?.discord || {};

  if (priorityTickets.length > 0) {
    const priorityPrefix =
      config.ticketFilter.prioritySignals?.[0]?.discordMessagePrefix ||
      "PRIORITY ticket available";
    const mention = discord.priorityMention ? `${discord.priorityMention} ` : "";
    lines.push(`${mention}${priorityPrefix}`);
    for (const ticket of priorityTickets) {
      lines.push(`- ${formatTicket(ticket)}`);
    }
    lines.push("");
  }

  const mention = discord.mention && priorityTickets.length === 0 ? `${discord.mention} ` : "";
  lines.push(`${mention}HYROX Toronto athlete ticket change detected.`);
  for (const ticket of newTickets) {
    lines.push(`- ${formatTicket(ticket)}`);
  }
  lines.push("");
  lines.push(config.event.ticketPageUrl);

  return lines.join("\n").slice(0, 1900);
}

async function sendDiscordMessage(config, content) {
  const discord = config.notifications?.discord;
  const webhookUrl = process.env[discord.webhookUrlEnvVar || "DISCORD_WEBHOOK_URL"];
  const enabledOverride = readBooleanEnv("DISCORD_ENABLED");
  const enabled = enabledOverride ?? discord?.enabled ?? false;

  if (!enabled) return false;

  if (!webhookUrl) {
    throw new Error(
      `Discord is enabled, but ${discord.webhookUrlEnvVar || "DISCORD_WEBHOOK_URL"} is not set.`
    );
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed: HTTP ${response.status} ${body}`);
  }

  return true;
}

function shouldSkipForInterval(state, config) {
  if (force || !state.lastCheckedAt) return false;

  const minimumMinutes = config.monitoring.minimumMinutesBetweenChecks || 0;
  if (minimumMinutes <= 0) return false;

  const lastCheckedAt = new Date(state.lastCheckedAt).getTime();
  if (!Number.isFinite(lastCheckedAt)) return false;

  const elapsedMs = Date.now() - lastCheckedAt;
  return elapsedMs < minimumMinutes * 60 * 1000;
}

async function main() {
  await loadDotEnv();

  const config = await loadJson(CONFIG_FILE);
  const stateFile = resolveStateFile(config);
  const state = await loadJson(stateFile, {
    lastCheckedAt: null,
    activeAthleteTicketIds: [],
    activeAthleteTickets: []
  });

  if (notifyTest) {
    const sent = await sendDiscordMessage(
      config,
      `HYROX ticket monitor test notification\n${config.event.ticketPageUrl}`
    );
    console.log(sent ? "Sent Discord test notification." : "Discord notification disabled.");
    return;
  }

  if (shouldSkipForInterval(state, config)) {
    console.log(
      `Skipped. Last checked at ${state.lastCheckedAt}; minimum interval is ${config.monitoring.minimumMinutesBetweenChecks} minutes. Use --force to check now.`
    );
    return;
  }

  const html = await fetchText(config.event.ticketPageUrl, config);
  const nextData = extractNextData(html);
  const event = nextData.props?.pageProps?.event;

  if (!event || !Array.isArray(event.tickets)) {
    throw new Error("Could not find event.tickets in the page JSON.");
  }

  const activeTickets = filterInterestingTickets(event.tickets, config);
  const previousActiveIds = new Set(state.activeAthleteTicketIds || []);
  const newTickets = activeTickets.filter((ticket) => !previousActiveIds.has(ticket.id));
  const firstRun = !state.lastCheckedAt;
  const priorityTickets = newTickets.filter((ticket) =>
    isPriorityTicket(ticket, config.ticketFilter.prioritySignals || [])
  );

  const nextState = {
    lastCheckedAt: new Date().toISOString(),
    eventName: event.name,
    eventId: event._id,
    ticketPageUrl: config.event.ticketPageUrl,
    activeAthleteTicketIds: activeTickets.map((ticket) => ticket.id),
    activeAthleteTickets: activeTickets,
    lastResult: {
      pageTicketCount: event.tickets.length,
      activeMatchedTicketCount: activeTickets.length,
      newMatchedTicketCount: firstRun ? 0 : newTickets.length,
      priorityNewMatchedTicketCount: firstRun ? 0 : priorityTickets.length
    }
  };

  if (!dryRun) {
    await writeJson(stateFile, nextState);
  }

  console.log(`Checked ${event.name}.`);
  console.log(`Page ticket types: ${event.tickets.length}`);
  console.log(`Active non-charity athlete tickets: ${activeTickets.length}`);

  if (activeTickets.length > 0) {
    for (const ticket of activeTickets) {
      console.log(`- ${formatTicket(ticket)}`);
    }
  }

  if (firstRun) {
    console.log(dryRun ? "Dry run only; no baseline state written." : "Baseline saved; no alert sent on first run.");
    return;
  }

  if (newTickets.length === 0) {
    console.log("No new active athlete tickets since the last run.");
    return;
  }

  const message = buildDiscordMessage({
    config,
    event,
    newTickets,
    priorityTickets
  });

  console.log("New active athlete tickets detected:");
  for (const ticket of newTickets) {
    const priority = priorityTickets.some((priorityTicket) => priorityTicket.id === ticket.id)
      ? " PRIORITY"
      : "";
    console.log(`- ${formatTicket(ticket)}${priority}`);
  }

  if (dryRun) {
    console.log("Dry run only; Discord notification not sent.");
    console.log(message);
    return;
  }

  const sent = await sendDiscordMessage(config, message);
  console.log(sent ? "Discord notification sent." : "Discord notification disabled.");
}

main().catch(async (error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
