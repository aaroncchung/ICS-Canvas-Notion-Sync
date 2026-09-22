import { Api, ApiError } from "./api.ts";
import { scan, serialExecutor, verifyAccount } from "./engine.ts";
import {
  canvasOrigin,
  emptyState,
  newReport,
  note,
  notionId,
  object,
  scalarText,
  UserError,
  VerificationError,
  type Config,
  type Report,
  type State,
} from "./model.ts";

type Configured = State & { config: Config };
interface Scanning {
  controller: AbortController;
  report: Report;
  progress: string;
}
const serial = serialExecutor();
// Hardening only. setAccessLevel exists since Chrome 102 for the session area but is accepted
// for the local area only from Chrome 140 (MDN browser-compat-data for StorageArea.setAccessLevel);
// before that it rejects. With no content script nothing untrusted can read the area anyway, so
// the call must never stop the extension from loading its state.
const ready = (async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    /* Unsupported here. */
  }
})();
const STATE_KEY = "companion-v1";
const COOLDOWN = 5 * 60_000;
const FAILURE_COOLDOWN = 60_000;
/** The most a Retry-After header may hold automatic scans back; Sync now is never held back. */
const LONGEST_COOLDOWN = 60 * 60_000;
/** Declared in the manifest, but Chrome still lets the user withhold it under site access. */
const NOTION_SITE = "https://api.notion.com/*";
const withdrawn = (site: "Canvas" | "Notion") =>
  new UserError(
    `${site} host access was removed. Allow that site for the extension in chrome://extensions.`,
  );
/** The scan in progress. It lives and dies with this worker; nothing about it is persisted. */
let active: Scanning | undefined;
/** Every scan that is queued or running, so Pause also reaches one that has not started yet. */
const launched = new Set<AbortController>();

async function load(): Promise<State> {
  await ready;
  const stored = await chrome.storage.local.get(STATE_KEY);
  return (stored[STATE_KEY] as State | undefined) ?? emptyState();
}
/** Only ever called inside `serial`, so whole-state writes cannot overwrite each other. */
async function save(state: State): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}
function view(state: State) {
  return {
    configured: Boolean(state.config),
    origin: state.config?.origin ?? "",
    dataSourceId: state.config?.dataSourceId ?? "",
    userId: state.config?.userId ?? "",
    enabled: state.config?.enabled ?? false,
    previewReady: state.previewReady,
    running: Boolean(active),
    progress: active?.progress,
    report: active?.report ?? state.report,
    error: state.error,
  };
}
function message(error: unknown): string {
  return error instanceof UserError
    ? error.message
    : "The scan stopped unexpectedly. Check your connection and try again.";
}
async function badge(state: State): Promise<void> {
  await chrome.action.setBadgeText({
    text: state.error ? "!" : active ? "…" : state.config?.enabled ? "ON" : "",
  });
}
async function prepare(mode: Report["mode"], force: boolean): Promise<Configured | undefined> {
  const state = await load();
  if (!state.config) {
    if (force) throw new UserError("No verified configuration. Open Settings first.");
    return;
  }
  if (mode === "sync" && !state.config.enabled) {
    // Pause leaves the preview standing, so only the switch itself is off.
    if (force)
      throw new UserError(
        state.previewReady
          ? "Automatic sync is off. Choose Enable sync first."
          : "Run Preview and enable syncing first.",
      );
    return;
  }
  if (!force && Date.now() < state.nextScanAt) return;
  return state as Configured;
}
async function execute(state: Configured, scanning: Scanning): Promise<void> {
  const { controller, report } = scanning;
  delete state.error;
  // Saved unfinished, so a scan cut short by worker termination shows as interrupted.
  state.report = report;
  await save(state);
  await badge(state);
  const api = new Api(state.config, {
    signal: controller.signal,
    // Calling an extension API resets the worker's 30-second idle timer.
    beat: () => chrome.storage.session.set({ beat: Date.now() }).catch(() => undefined),
  });
  try {
    // Site access can be withdrawn in chrome://extensions at any time, for Notion as much as for
    // Canvas. Every request to that site would then fail like a dead network, so it is named here
    // instead. It comes back by itself once access is restored, so automatic sync stays on.
    for (const [site, pattern] of [
      ["Canvas", `${state.config.origin}/*`],
      ["Notion", NOTION_SITE],
    ] as const)
      if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw withdrawn(site);
    await scan(state.config, report, {
      api,
      acknowledged: state.acknowledged,
      saveAcknowledged: () => save(state),
      progress: (text) => {
        scanning.progress = text;
      },
    });
    if (report.mode === "preview") state.previewReady = true;
    state.nextScanAt = Date.now() + COOLDOWN;
  } catch (error) {
    if (controller.signal.aborted) {
      // Ranked with failures, so a full list of routine rows cannot crowd it out.
      note(report, "Scan", "skipped", "Paused before finishing", 0);
    } else {
      state.error = message(error);
      report.failed++;
      // A service that says how long to stay away is not asked again every minute meanwhile.
      const asked = error instanceof ApiError ? Math.min(error.retryAfter, LONGEST_COOLDOWN) : 0;
      state.nextScanAt = Date.now() + Math.max(FAILURE_COOLDOWN, asked);
      // Outages and expired sessions pass by themselves. Only a changed account or schema, or
      // an integration that may not write, needs the user to look before the next write.
      if (error instanceof VerificationError) {
        state.config.enabled = false;
        state.previewReady = false;
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  await save(state);
}
/** Settles once the scan has started or been declined; the scan itself continues in the queue. */
function launch(mode: Report["mode"], force: boolean): Promise<void> {
  const controller = new AbortController();
  launched.add(controller);
  return new Promise((started, declined) => {
    void serial(async () => {
      let state: Configured | undefined;
      try {
        state = await prepare(mode, force);
      } catch (error) {
        declined(error instanceof Error ? error : new Error("The scan could not start"));
        return;
      }
      // Pause may have arrived while this scan was still waiting its turn.
      if (!state || controller.signal.aborted) {
        started();
        return;
      }
      const scanning: Scanning = {
        controller,
        report: newReport(mode, Date.now()),
        progress: "Starting",
      };
      active = scanning;
      started();
      try {
        await execute(state, scanning);
      } finally {
        active = undefined;
        await badge(state);
      }
    })
      .catch(() => undefined)
      .finally(() => launched.delete(controller));
  });
}
async function visibleCanvas(origin: string): Promise<boolean> {
  const window = await chrome.windows.getLastFocused();
  if (!window.focused || window.id === undefined) return false;
  const tabs = await chrome.tabs.query({ active: true, windowId: window.id });
  return tabs.some((tab) => tab.url && new URL(tab.url).origin === origin);
}
function wake(checkVisibility: boolean, origin?: string): void {
  if (launched.size) return;
  void (async () => {
    const state = await load();
    if (!state.config?.enabled || Date.now() < state.nextScanAt) return;
    if (origin && origin !== state.config.origin) return;
    if (checkVisibility && !(await visibleCanvas(state.config.origin))) return;
    // Triggers that raced past these checks are declined by the cooldown once queued.
    await launch("sync", false);
  })().catch(() => undefined);
}
type Connection = Pick<Config, "origin" | "token" | "dataSourceId">;
/** The form as a connection to try. A blank token means the saved one. Nothing is contacted. */
function candidate(origin: string, raw: Record<string, unknown>, previous: State): Connection {
  const token =
    typeof raw.token === "string" && raw.token.trim() ? raw.token.trim() : previous.config?.token;
  // Stored in the lowercase form Notion answers with, so later comparisons are exact.
  const dataSourceId = scalarText(raw.dataSourceId ?? "")
    .trim()
    .toLowerCase();
  if (!token || token.length > 512 || /[\r\n]/.test(token))
    throw new UserError("Enter a valid Notion integration token.");
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(dataSourceId))
    throw new UserError("Enter a Notion data-source ID (UUID).");
  return { origin, token, dataSourceId };
}
/** Checks the connection itself. Nothing is saved here. */
async function verified(connection: Connection): Promise<Config> {
  if (!(await chrome.permissions.contains({ origins: [`${connection.origin}/*`] })))
    throw new UserError("Canvas host access has not been granted.");
  // Otherwise the schema check below fails like a dead network, which says nothing useful.
  if (!(await chrome.permissions.contains({ origins: [NOTION_SITE] }))) throw withdrawn("Notion");
  const api = new Api(connection);
  const userId = await api.user();
  await api.validateSchema();
  return { ...connection, userId, enabled: false };
}
function sameConnection(a: Connection, b: Connection): boolean {
  return (
    a.origin === b.origin &&
    a.token === b.token &&
    notionId(a.dataSourceId) === notionId(b.dataSourceId)
  );
}
async function configure(raw: Record<string, unknown>): Promise<void> {
  const previous = await load();
  // The settings page asks for host access only for an origin that passes this same check.
  const origin = canvasOrigin(scalarText(raw.origin ?? ""));
  if (!origin) throw new UserError("Enter the Canvas HTTPS origin, without a path.");
  let config: Config;
  let tried: Connection | undefined;
  try {
    tried = candidate(origin, raw, previous);
    config = await verified(tried);
  } catch (error) {
    // Host access granted for this attempt is not kept for a connection that did not verify,
    // whether it was the form or the connection that failed.
    if (origin !== previous.config?.origin)
      await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => undefined);
    // Proof that the saved connection itself no longer verifies counts as much here as it would
    // in a scan: automatic sync goes off until Settings verify again. A new token or data source
    // that fails says nothing about the saved one, which stays as it is.
    if (
      error instanceof VerificationError &&
      tried &&
      previous.config &&
      sameConnection(tried, previous.config)
    ) {
      previous.config.enabled = false;
      previous.previewReady = false;
      previous.error = error.message;
      // The diagnosis matters more than a storage hiccup, and the next scan disables sync anyway.
      await save(previous)
        .then(() => badge(previous))
        .catch(() => undefined);
    }
    throw error;
  }
  const same =
    previous.config?.origin === origin &&
    previous.config.userId === config.userId &&
    notionId(previous.config.dataSourceId) === notionId(config.dataSourceId);
  const state = same ? previous : emptyState();
  state.config = config;
  state.previewReady = false;
  delete state.error;
  await save(state);
  await badge(state);
  if (previous.config?.origin && previous.config.origin !== origin) {
    await chrome.permissions.remove({ origins: [`${previous.config.origin}/*`] });
  }
}
async function setEnabled(enabled: boolean): Promise<void> {
  const state = await load();
  if (!state.config) throw new UserError("No verified configuration.");
  if (enabled) {
    if (!state.previewReady) throw new UserError("Run a successful Preview first.");
    await verifyAccount(state.config, new Api(state.config));
  }
  state.config.enabled = enabled;
  await save(state);
  await badge(state);
}
async function handle(request: Record<string, unknown>): Promise<void> {
  const action = request.action;
  if (action === "state") return;
  if (action === "pause") {
    // Stop the requests at once; the setting is written as soon as the scan has unwound.
    for (const controller of launched) controller.abort();
    return serial(() => setEnabled(false));
  }
  if (launched.size) throw new UserError("A scan is running. Wait for it to finish, or pause it.");
  if (action === "preview" || action === "sync") return launch(action, true);
  if (action === "configure") return serial(() => configure(object(request.config)));
  if (action === "enable") return serial(() => setEnabled(true));
  throw new UserError("Unknown action");
}
chrome.runtime.onMessage.addListener((raw: unknown, sender, respond: (value: unknown) => void) => {
  const allowed = [chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("options.html")];
  if (sender.id !== chrome.runtime.id || !sender.url || !allowed.includes(sender.url)) return false;
  // Reading state never waits behind a scan, so the popup stays live while one runs.
  handle(object(raw))
    .then(load)
    .then(
      (state) => respond({ ok: true, state: view(state) }),
      (error) => respond({ ok: false, error: message(error) }),
    );
  return true;
});
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status === "complete" && tab.url) {
    try {
      wake(false, new URL(tab.url).origin);
    } catch {
      /* Non-web tab. */
    }
  }
});
chrome.tabs.onActivated.addListener(() => wake(true));
chrome.windows.onFocusChanged.addListener(() => wake(true));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick") wake(true);
});
async function initialize(): Promise<void> {
  await ready;
  if (!(await chrome.alarms.get("tick")))
    await chrome.alarms.create("tick", { periodInMinutes: 1 });
  await badge(await load());
}
chrome.runtime.onStartup.addListener(() => {
  void initialize().catch(() => undefined);
});
chrome.runtime.onInstalled.addListener(() => {
  void initialize().catch(() => undefined);
});
void initialize().catch(() => undefined);
