const fs = require("node:fs/promises");
const path = require("node:path");

const CONFIG_FILE = path.join(__dirname, "monitor.config.json");
const DOT_ENV_FILE = path.join(__dirname, ".env");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force") || dryRun;
const notifyTest = args.has("--notify-test");
const workflowFailureNotify = args.has("--workflow-failure-notify");
const AVAILABILITY_DETECTOR_VERSION = 3;
const defaultEventState = {
  lastCheckedAt: null,
  activeAthleteTicketIds: [],
  activeAthleteTickets: []
};
const defaultState = {
  lastCheckedAt: null,
  events: {}
};

if (args.has("--help")) {
  console.log(`
Usage:
  node monitor.js                 Check if enough time has passed since the last run
  node monitor.js --force          Check now, ignoring the minimum interval
  node monitor.js --dry-run        Check now without writing state or sending Discord
  node monitor.js --notify-test    Send a test Discord notification
  node monitor.js --workflow-failure-notify
                                  Send a GitHub workflow failure notification
`);
  process.exit(0);
}

function getNestedValue(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, object);
}

function slugify(value) {
  return String(value || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "event";
}

function getConfiguredEvents(config) {
  const events = Array.isArray(config.events) && config.events.length > 0
    ? config.events
    : [config.event].filter(Boolean);

  return events.map((eventConfig, index) => ({
    ...eventConfig,
    key: eventConfig.key || slugify(eventConfig.name || eventConfig.ticketPageUrl || index)
  }));
}

function validateConfig(config) {
  const mode = config.monitoring?.mode || "checkout_page_availability_json";
  if (mode !== "checkout_page_availability_json") {
    throw new Error(`Unsupported monitoring.mode: ${mode}`);
  }

  if (getConfiguredEvents(config).length === 0) {
    throw new Error("No HYROX events configured.");
  }
}

function getEventState(state, eventConfig) {
  if (state.events?.[eventConfig.key]) {
    return state.events[eventConfig.key];
  }

  // Backward compatibility for the original one-event Toronto state shape.
  if (
    eventConfig.key === "toronto" &&
    Array.isArray(state.activeAthleteTicketIds)
  ) {
    return {
      lastCheckedAt: state.lastCheckedAt || null,
      eventName: state.eventName,
      eventId: state.eventId,
      ticketPageUrl: state.ticketPageUrl,
      activeAthleteTicketIds: state.activeAthleteTicketIds,
      activeAthleteTickets: state.activeAthleteTickets || [],
      lastResult: state.lastResult
    };
  }

  return { ...defaultEventState };
}

function getEventUrls(config) {
  return [
    ...new Set(
      getConfiguredEvents(config)
        .flatMap((eventConfig) => [
          eventConfig.ticketPageUrl,
          eventConfig.officialEventPageUrl
        ])
        .filter(Boolean)
    )
  ];
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, raw, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrlsFromHtml(html, baseUrl) {
  const rawUrls = new Set();
  const attributePattern = /\b(?:href|src|data-[a-z0-9_-]+)=["']([^"']+)["']/gi;
  const absoluteUrlPattern = /https?:\/\/[^\s"'<>\\]+/gi;
  let match;

  while ((match = attributePattern.exec(html)) !== null) {
    rawUrls.add(match[1]);
  }

  while ((match = absoluteUrlPattern.exec(html)) !== null) {
    rawUrls.add(match[0]);
  }

  return [...rawUrls]
    .map((url) => decodeHtmlEntities(url))
    .map((url) => {
      try {
        return new URL(url, baseUrl).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isLikelyTicketPageUrl(candidateUrl, officialEventPageUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const official = new URL(officialEventPageUrl);

    if (candidate.href === official.href) return false;
    if (candidate.hostname === official.hostname) return false;
    if (!/hyrox|vivenu/i.test(candidate.hostname)) return false;
    if (!/^\/event\/[^/]+\/?$/i.test(candidate.pathname)) return false;

    return true;
  } catch {
    return false;
  }
}

function discoverTicketPageUrl(officialPageHtml, eventConfig) {
  if (!eventConfig.officialEventPageUrl) return null;

  const urls = extractUrlsFromHtml(officialPageHtml, eventConfig.officialEventPageUrl);
  return urls.find((url) => isLikelyTicketPageUrl(url, eventConfig.officialEventPageUrl)) || null;
}

function summarizeOfficialPage(officialPageHtml, eventConfig) {
  const text = stripHtml(officialPageHtml);
  const candidateTicketPageUrls = eventConfig.officialEventPageUrl
    ? extractUrlsFromHtml(officialPageHtml, eventConfig.officialEventPageUrl)
        .filter((url) => isLikelyTicketPageUrl(url, eventConfig.officialEventPageUrl))
    : [];

  return {
    ticketSalesStartSoon: /ticket sales start soon/i.test(text),
    candidateTicketPageUrls
  };
}

function getTicketId(ticket) {
  return ticket.id || ticket._id;
}

function getEventCategory(event, ticket) {
  return (event.categories || []).find((category) => category.ref === ticket.categoryRef);
}

function volumeOrFallback(value, fallback) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(value, 0);
}

function getTicketAvailability(ticket, event) {
  const category = getEventCategory(event, ticket);
  const ticketVolume = volumeOrFallback(ticket.v, 0);
  const categoryVolume = category ? volumeOrFallback(category.v, Infinity) : Infinity;
  const eventVolume = volumeOrFallback(event.v, Infinity);
  const ticketOrderMax = volumeOrFallback(ticket.maxAmountPerOrder, Infinity);
  const categoryOrderMax = volumeOrFallback(category?.maxAmountPerOrder, Infinity);
  const eventOrderMax = volumeOrFallback(event.max, Infinity);
  const minOrderAmount = volumeOrFallback(ticket.minAmountPerOrder, 0);
  const minOrderRule = volumeOrFallback(ticket.minAmountPerOrderRule, 0);
  let quantity = Math.min(
    ticketVolume,
    categoryVolume,
    eventVolume,
    ticketOrderMax,
    categoryOrderMax,
    eventOrderMax
  );

  if (minOrderRule <= 1 && quantity < minOrderAmount) {
    quantity = 0;
  }

  const blockedByRules =
    ticket.conditionalAvailability === true &&
    ticket.conditionalAvailabilityMode === "blockAddToCart" &&
    Array.isArray(ticket.rules) &&
    ticket.rules.length > 0;

  return {
    quantity,
    blockedByRules,
    ticketVolume,
    categoryVolume: Number.isFinite(categoryVolume) ? categoryVolume : null,
    eventVolume: Number.isFinite(eventVolume) ? eventVolume : null,
    categoryName: category?.name || null
  };
}

function normalizeTicket(ticket, event) {
  const availability = getTicketAvailability(ticket, event);

  return {
    id: getTicketId(ticket),
    name: ticket.name,
    active: ticket.active === true,
    hidden: ticket.styleOptions?.hiddenInSelectionArea === true,
    isCompetition: ticket.meta?.is_competition,
    competitionClass: ticket.meta?.competition_class_matching_key,
    competitionDayIndex: ticket.meta?.competition_day_idx,
    date: ticket.relevancyDate?.start || null,
    availableQuantity: availability.quantity,
    buyable:
      ticket.active === true &&
      availability.quantity > 0 &&
      availability.blockedByRules === false,
    availability
  };
}

function ticketNameHasAny(ticket, fragments) {
  const name = String(ticket.name || "").toUpperCase();
  return fragments.some((fragment) => name.includes(String(fragment).toUpperCase()));
}

function getTicketsById(tickets = []) {
  const ticketsById = new Map();

  for (const ticket of tickets) {
    if (ticket?.id) {
      ticketsById.set(ticket.id, ticket);
    }
  }

  return ticketsById;
}

function isQuantityIncrease(ticket, previousTicket) {
  return (
    previousTicket &&
    typeof ticket.availableQuantity === "number" &&
    typeof previousTicket.availableQuantity === "number" &&
    ticket.availableQuantity > previousTicket.availableQuantity
  );
}

function getChangedTickets(availableTickets, eventState, detectorChanged, alertOnlyOnChanges) {
  if (!alertOnlyOnChanges) {
    return {
      alertTickets: availableTickets,
      quantityIncreaseTickets: []
    };
  }

  const previousTicketsById = getTicketsById(
    detectorChanged ? [] : eventState.activeAthleteTickets || []
  );
  const previousActiveIds = new Set(
    detectorChanged ? [] : eventState.activeAthleteTicketIds || []
  );
  const quantityIncreaseTickets = availableTickets.filter((ticket) =>
    isQuantityIncrease(ticket, previousTicketsById.get(ticket.id))
  );
  const alertTickets = availableTickets
    .filter((ticket) => {
      const previousTicket = previousTicketsById.get(ticket.id);
      return (
        !previousActiveIds.has(ticket.id) ||
        isQuantityIncrease(ticket, previousTicket)
      );
    })
    .map((ticket) => {
      const previousTicket = previousTicketsById.get(ticket.id);
      if (!isQuantityIncrease(ticket, previousTicket)) {
        return ticket;
      }

      return {
        ...ticket,
        previousAvailableQuantity: previousTicket.availableQuantity
      };
    });

  return {
    alertTickets,
    quantityIncreaseTickets
  };
}

function readBooleanEnv(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return undefined;
}

function shouldNotify(config, type) {
  const notifyOn = config.notifications?.discord?.notifyOn;
  if (!Array.isArray(notifyOn)) return true;
  return notifyOn.includes(type);
}

function shouldNotifyTicketAlert(config, priorityTickets) {
  if (
    priorityTickets.length > 0 &&
    shouldNotify(config, "priority_ticket_became_active")
  ) {
    return true;
  }

  return (
    shouldNotify(config, "new_active_athlete_ticket") ||
    shouldNotify(config, "ticket_became_active")
  );
}

function resolveStateFile(config) {
  const configuredPath = process.env.HYROX_STATE_FILE || config.monitoring.stateFile;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

function resolveLogFile(config) {
  const configuredPath = process.env.HYROX_LOG_FILE || config.monitoring.logFile || "monitor.log";
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

function resolveErrorNotifiedFile(config) {
  const configuredPath = process.env.HYROX_ERROR_NOTIFIED_FILE;
  if (!configuredPath) return null;

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

async function appendLog(config, level, message, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
    ...details
  };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    const logFile = resolveLogFile(config);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, line, "utf8");
  } catch (logError) {
    console.error("Failed to write monitor log:", logError.message);
  }
}

async function markErrorNotified(config) {
  const markerFile = resolveErrorNotifiedFile(config);
  if (!markerFile) return;

  try {
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, new Date().toISOString(), "utf8");
  } catch (error) {
    console.error("Failed to write error notification marker:", error.message);
  }
}

async function withRetries(config, label, operation) {
  const attempts = Math.max(1, config.monitoring.retryAttempts || 1);
  const delayMs = Math.max(0, config.monitoring.retryDelaySeconds || 0) * 1000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      await appendLog(config, "warn", `${label} failed`, {
        attempt,
        attempts,
        error: serializeError(error)
      });

      if (attempt < attempts && delayMs > 0) {
        console.warn(`${label} failed on attempt ${attempt}/${attempts}; retrying.`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
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

function mergeTicketFilter(config, eventConfig) {
  const globalFilter = config.ticketFilter || {};
  const eventFilter = eventConfig.ticketFilter || {};

  return {
    ...globalFilter,
    ...eventFilter,
    availableWhen: {
      ...(globalFilter.availableWhen || {}),
      ...(eventFilter.availableWhen || {})
    },
    ignoreNamesContaining:
      eventFilter.ignoreNamesContaining || globalFilter.ignoreNamesContaining || [],
    includedCompetitionClasses:
      eventFilter.includedCompetitionClasses || globalFilter.includedCompetitionClasses || [],
    excludedCompetitionClasses:
      eventFilter.excludedCompetitionClasses || globalFilter.excludedCompetitionClasses || [],
    prioritySignals:
      eventFilter.prioritySignals || globalFilter.prioritySignals || []
  };
}

function filterInterestingTickets(rawTickets, filter, event) {
  const ignoredNames = filter.ignoreNamesContaining || [];
  const includedClasses =
    filter.includedCompetitionClasses?.length > 0
      ? new Set(filter.includedCompetitionClasses)
      : null;
  const excludedClasses = new Set(filter.excludedCompetitionClasses || []);
  const availableField = filter.availableWhen?.field || "buyable";
  const availableValue = filter.availableWhen?.equals ?? true;

  return rawTickets
    .map((ticket) => normalizeTicket(ticket, event))
    .filter((ticket) => ticket.id)
    .filter((ticket) => !ticket.hidden)
    .filter((ticket) => !ticketNameHasAny(ticket, ignoredNames))
    .filter((ticket) => {
      if (!filter.onlyAthleteTickets) return true;
      return getNestedValue({ meta: { is_competition: ticket.isCompetition } }, filter.competitionMetaField) === filter.competitionMetaValue;
    })
    .filter((ticket) => !includedClasses || includedClasses.has(ticket.competitionClass))
    .filter((ticket) => !excludedClasses.has(ticket.competitionClass))
    .filter((ticket) => ticket[availableField] === availableValue)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatDateInTimeZone(value, timeZone) {
  if (!value) return "unknown date";

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);
  if (!timeZone) return date.toISOString().slice(0, 10);

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    if (!year || !month || !day) return date.toISOString().slice(0, 10);
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatTicket(ticket, eventConfig = {}) {
  const date = formatDateInTimeZone(ticket.date, eventConfig.eventDates?.timezone);
  const available =
    typeof ticket.availableQuantity === "number"
      ? `, ${ticket.availableQuantity} available`
      : "";
  const previousAvailable =
    typeof ticket.previousAvailableQuantity === "number"
      ? `, was ${ticket.previousAvailableQuantity}`
      : "";
  return `${ticket.name} (${ticket.competitionClass || "unknown class"}, ${date}${available}${previousAvailable})`;
}

function buildDiscordMessage({ config, eventConfig, event, newTickets, priorityTickets, ticketFilter }) {
  const lines = [];
  const discord = config.notifications?.discord || {};
  const eventName = event?.name || eventConfig.name || "HYROX event";

  if (priorityTickets.length > 0) {
    const priorityPrefix =
      ticketFilter.prioritySignals?.[0]?.discordMessagePrefix ||
      "PRIORITY ticket available";
    const mention = discord.priorityMention ? `${discord.priorityMention} ` : "";
    lines.push(`${mention}${priorityPrefix}: ${eventName}`);
    for (const ticket of priorityTickets) {
      lines.push(`- ${formatTicket(ticket, eventConfig)}`);
    }
    lines.push("");
  }

  const mention = discord.mention && priorityTickets.length === 0 ? `${discord.mention} ` : "";
  lines.push(`${mention}${eventName} new or increased monitored athlete ticket availability detected.`);
  for (const ticket of newTickets) {
    lines.push(`- ${formatTicket(ticket, eventConfig)}`);
  }
  lines.push("");
  lines.push(eventConfig.ticketPageUrl);

  return lines.join("\n").slice(0, 1900);
}

async function sendDiscordMessage(config, content) {
  const discord = config.notifications?.discord || {};
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

function getGitHubRunUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!serverUrl || !repository || !runId) return null;
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function buildMonitorErrorMessage(config, error, context = {}) {
  const runUrl = getGitHubRunUrl();
  const serialized = serializeError(error);
  const lines = [
    "HYROX ticket monitor problem after retries.",
    `Stage: ${context.stage || "unknown"}`,
    `Error: ${serialized.name}: ${serialized.message}`,
    ""
  ];

  lines.push(...getEventUrls(config));

  if (runUrl) {
    lines.push("");
    lines.push(`GitHub run: ${runUrl}`);
  }

  return lines.filter(Boolean).join("\n").slice(0, 1900);
}

function deriveCheckoutPageUrl(eventConfig, event) {
  if (eventConfig.checkoutPageUrl) return eventConfig.checkoutPageUrl;

  const eventId = event?._id || event?.id;
  if (!eventId) {
    throw new Error(`Could not derive checkout URL because ${eventConfig.name} has no event ID.`);
  }

  const ticketPage = new URL(eventConfig.ticketPageUrl);
  const checkoutPage = new URL(`/checkout/${eventId}`, ticketPage);
  checkoutPage.search = ticketPage.search;
  return checkoutPage.href;
}

function validateEventTickets(event, eventConfig, sourceLabel) {
  if (!event || !Array.isArray(event.tickets)) {
    throw new Error(`Could not find event.tickets in the ${sourceLabel} JSON for ${eventConfig.name}.`);
  }
}

function validateCheckoutAvailability(event, eventConfig) {
  validateEventTickets(event, eventConfig, "checkout page");

  if (!event.tickets.some((ticket) => Object.prototype.hasOwnProperty.call(ticket, "v"))) {
    throw new Error(`Could not find checkout ticket availability volumes for ${eventConfig.name}.`);
  }
}

function buildWorkflowFailureMessage(config) {
  const runUrl = getGitHubRunUrl();
  const headline = runUrl
    ? "HYROX ticket monitor workflow failed outside the monitor script."
    : "TEST: HYROX ticket monitor workflow-failure notification.";
  const lines = [
    headline
  ];

  lines.push(...getEventUrls(config));

  if (runUrl) {
    lines.push("");
    lines.push(`GitHub run: ${runUrl}`);
  }

  return lines.filter(Boolean).join("\n").slice(0, 1900);
}

async function notifyMonitorError(config, error, context = {}) {
  if (!shouldNotify(config, "monitor_error_after_retries")) {
    console.log("Discord error notification type disabled.");
    await markErrorNotified(config);
    return;
  }

  const message = buildMonitorErrorMessage(config, error, context);

  try {
    const sent = await sendDiscordMessage(config, message);
    console.log(sent ? "Discord error notification sent." : "Discord error notification disabled.");
    if (sent) {
      await markErrorNotified(config);
    }
  } catch (notificationError) {
    console.error("Failed to send Discord error notification:", notificationError.message);
  }
}

async function recordMonitorError(config, state, error, context = {}) {
  const stateFile = resolveStateFile(config);
  const nextState = {
    ...defaultState,
    ...state,
    lastErrorAt: new Date().toISOString(),
    lastError: {
      stage: context.stage || "unknown",
      ...serializeError(error)
    }
  };

  await writeJson(stateFile, nextState);
  await appendLog(config, "error", "Monitor failed", {
    stage: context.stage || "unknown",
    error: serializeError(error)
  });
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
  validateConfig(config);
  const stateFile = resolveStateFile(config);
  const state = await loadJson(stateFile, defaultState);

  if (notifyTest) {
    const sent = await sendDiscordMessage(
      config,
      `HYROX ticket monitor test notification\n${getEventUrls(config).join("\n")}`
    );
    console.log(sent ? "Sent Discord test notification." : "Discord notification disabled.");
    return;
  }

  if (workflowFailureNotify) {
    const sent = await sendDiscordMessage(config, buildWorkflowFailureMessage(config));
    console.log(sent ? "Sent Discord workflow failure notification." : "Discord notification disabled.");
    return;
  }

  if (shouldSkipForInterval(state, config)) {
    console.log(
      `Skipped. Last checked at ${state.lastCheckedAt}; minimum interval is ${config.monitoring.minimumMinutesBetweenChecks} minutes. Use --force to check now.`
    );
    return;
  }

  const configuredEvents = getConfiguredEvents(config);
  const checkedAt = new Date().toISOString();
  const nextState = {
    events: {
      ...(state.events || {})
    },
    lastCheckedAt: checkedAt
  };

  const alertMessages = [];

  for (const eventConfig of configuredEvents) {
    const eventState = getEventState(state, eventConfig);
    let ticketPageUrl = eventConfig.ticketPageUrl;

    if (!ticketPageUrl) {
      if (!eventConfig.officialEventPageUrl) {
        throw new Error(`No ticketPageUrl or officialEventPageUrl configured for ${eventConfig.name}.`);
      }

      const officialPageHtml = await withRetries(
        config,
        `Fetch official event page for ${eventConfig.name}`,
        () => fetchText(eventConfig.officialEventPageUrl, config)
      );
      const officialPageSummary = summarizeOfficialPage(officialPageHtml, eventConfig);
      ticketPageUrl = discoverTicketPageUrl(officialPageHtml, eventConfig);

      if (!ticketPageUrl) {
        nextState.events[eventConfig.key] = {
          lastCheckedAt: checkedAt,
          eventName: eventConfig.name,
          officialEventPageUrl: eventConfig.officialEventPageUrl,
          ticketPageUrl: null,
          checkoutPageUrl: null,
          availabilityDetectorVersion: AVAILABILITY_DETECTOR_VERSION,
          activeAthleteTicketIds: [],
          activeAthleteTickets: [],
          lastResult: {
            status: "waiting_for_ticket_page",
            officialPageTicketSalesStartSoon: officialPageSummary.ticketSalesStartSoon,
            candidateTicketPageUrlCount: officialPageSummary.candidateTicketPageUrls.length,
            availableMatchedTicketCount: 0,
            newMatchedTicketCount: 0,
            priorityNewMatchedTicketCount: 0
          }
        };

        console.log(`Checked ${eventConfig.name}.`);
        console.log("No ticket page found yet on the official event page.");
        if (officialPageSummary.ticketSalesStartSoon) {
          console.log("Official page currently says: Ticket sales start soon.");
        }
        continue;
      }

      console.log(`Discovered ticket page for ${eventConfig.name}: ${ticketPageUrl}`);
    }

    const resolvedEventConfig = {
      ...eventConfig,
      ticketPageUrl
    };
    const pageEvent = await withRetries(config, `Fetch event page for ${eventConfig.name}`, async () => {
      const nextData = extractNextData(await fetchText(ticketPageUrl, config));
      const pageEvent = nextData.props?.pageProps?.event;

      validateEventTickets(pageEvent, resolvedEventConfig, "event page");

      return pageEvent;
    });
    const checkoutPageUrl = deriveCheckoutPageUrl(resolvedEventConfig, pageEvent);
    const checkoutEvent = await withRetries(config, `Fetch checkout availability for ${eventConfig.name}`, async () => {
      const nextData = extractNextData(await fetchText(checkoutPageUrl, config));
      const pageEvent = nextData.props?.pageProps?.event;

      validateCheckoutAvailability(pageEvent, resolvedEventConfig);

      return pageEvent;
    });
    const event = {
      ...pageEvent,
      ...checkoutEvent,
      tickets: checkoutEvent.tickets,
      categories: checkoutEvent.categories || pageEvent.categories || []
    };

    const ticketFilter = mergeTicketFilter(config, resolvedEventConfig);
    const availableTickets = filterInterestingTickets(event.tickets, ticketFilter, event);
    const detectorChanged =
      !!eventState.lastCheckedAt &&
      eventState.availabilityDetectorVersion !== AVAILABILITY_DETECTOR_VERSION;
    const firstRun = !eventState.lastCheckedAt;
    const alertOnFirstRun = config.monitoring.alertOnFirstRunAvailableTickets === true;
    const alertOnlyOnChanges = config.monitoring.alertOnlyOnChanges !== false;
    const changedTickets = getChangedTickets(
      availableTickets,
      eventState,
      detectorChanged,
      alertOnlyOnChanges
    );
    const alertTickets = firstRun
      ? (alertOnFirstRun ? availableTickets : [])
      : changedTickets.alertTickets;
    const quantityIncreaseTickets = firstRun ? [] : changedTickets.quantityIncreaseTickets;
    const priorityTickets = alertTickets.filter((ticket) =>
      isPriorityTicket(ticket, ticketFilter.prioritySignals || [])
    );

    nextState.events[eventConfig.key] = {
      lastCheckedAt: checkedAt,
      eventName: event.name,
      eventId: event._id,
      officialEventPageUrl: eventConfig.officialEventPageUrl,
      ticketPageUrl,
      checkoutPageUrl,
      availabilityDetectorVersion: AVAILABILITY_DETECTOR_VERSION,
      activeAthleteTicketIds: availableTickets.map((ticket) => ticket.id),
      activeAthleteTickets: availableTickets,
      lastResult: {
        pageTicketCount: event.tickets.length,
        availableMatchedTicketCount: availableTickets.length,
        newMatchedTicketCount: alertTickets.length,
        quantityIncreaseMatchedTicketCount: quantityIncreaseTickets.length,
        priorityNewMatchedTicketCount: priorityTickets.length
      }
    };

    console.log(`Checked ${event.name}.`);
    console.log(`Page ticket types: ${event.tickets.length}`);
    console.log(`Available monitored athlete tickets: ${availableTickets.length}`);

    if (availableTickets.length > 0) {
      for (const ticket of availableTickets) {
        console.log(`- ${formatTicket(ticket, resolvedEventConfig)}`);
      }
    }

    if (firstRun && alertTickets.length === 0) {
      console.log(dryRun ? "Dry run only; no baseline state written for this event." : "Baseline saved for this event; no alert sent on first run.");
      continue;
    }

    if (firstRun) {
      console.log("First run has available monitored tickets; alerting because alertOnFirstRunAvailableTickets is enabled.");
    }

    if (detectorChanged && availableTickets.length > 0) {
      console.log("Availability detector changed; current buyable tickets are being treated as new.");
    }

    if (alertTickets.length === 0) {
      console.log("No new or increased available monitored athlete tickets for this event since the last run.");
      continue;
    }

    const message = buildDiscordMessage({
      config,
      eventConfig: resolvedEventConfig,
      event,
      newTickets: alertTickets,
      priorityTickets,
      ticketFilter
    });

    console.log("New or increased available monitored athlete tickets detected:");
    for (const ticket of alertTickets) {
      const priority = priorityTickets.some((priorityTicket) => priorityTicket.id === ticket.id)
        ? " PRIORITY"
        : "";
      console.log(`- ${formatTicket(ticket, resolvedEventConfig)}${priority}`);
    }

    if (shouldNotifyTicketAlert(config, priorityTickets)) {
      alertMessages.push(message);
    } else {
      console.log("Discord ticket notification type disabled; state will still be updated.");
    }
  }

  if (alertMessages.length === 0) {
    if (!dryRun) {
      await writeJson(stateFile, nextState);
    }
    return;
  }

  if (dryRun) {
    console.log("Dry run only; Discord notification not sent.");
    console.log(alertMessages.join("\n\n---\n\n"));
    return;
  }

  for (const message of alertMessages) {
    const sent = await withRetries(config, "Send Discord ticket notification", () =>
      sendDiscordMessage(config, message)
    );
    if (!sent) {
      throw new Error("Discord notification was required for ticket alerts, but Discord is disabled.");
    }
    console.log(sent ? "Discord notification sent." : "Discord notification disabled.");
  }

  if (!dryRun) {
    await writeJson(stateFile, nextState);
  }
}

async function run() {
  let config = null;
  let state = defaultState;
  let stage = "startup";

  try {
    await loadDotEnv();
    config = await loadJson(CONFIG_FILE);
    state = await loadJson(resolveStateFile(config), defaultState);
    stage = "monitor";
    await main();
  } catch (error) {
    console.error(error.stack || error.message || error);

    if (config && !dryRun) {
      try {
        let latestState = state;

        try {
          latestState = await loadJson(resolveStateFile(config), state);
        } catch (stateError) {
          console.error("Could not reload state while handling error:", stateError.message);
        }

        await recordMonitorError(config, latestState, error, { stage });
        await notifyMonitorError(config, error, { stage });
      } catch (handlingError) {
        console.error("Failed while handling monitor error:", handlingError.stack || handlingError.message || handlingError);
      }
    } else if (dryRun) {
      console.error("Dry run only; error state and Discord error notification were not written.");
    }

    process.exitCode = 1;
  }
}

run().catch(async (error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
