import { canvasOrigin, object, scalarText } from "./model.ts";

const element = (id: string): HTMLElement => document.getElementById(id)!;
const input = (id: string): HTMLInputElement => element(id) as HTMLInputElement;
const SUBMIT = "#config button[type=submit]";
let filled = false;
let busy = false;
/** The scan rows on screen, so an unchanged list is not built again. */
let shownDetails: string | undefined;
let asking: ReturnType<typeof setTimeout> | undefined;
/**
 * Asks the worker for its state once, however many reasons to ask arrive meanwhile. Asking keeps
 * the worker running, so a page left open in a background tab does not ask until it is shown.
 */
function refresh(delay = 0): void {
  if (asking !== undefined) return;
  asking = setTimeout(() => {
    asking = undefined;
    if (!busy && document.visibilityState === "visible") void send("state").catch(() => undefined);
  }, delay);
}
/** Scan outcomes in the order they deserve reading: the word, mark and tone the log gives each. */
const OUTCOMES = [
  ["failed", "failed", "✕", "bad"],
  ["unchecked", "unchecked", "?", "warn"],
  ["updated", "done", "✓", "good"],
  ["eligible", "would be done", "→", "info"],
  ["skipped", "skipped", "–", "idle"],
] as const;
/** The worker's last answer, kept so typing in the filter can draw the rows again. */
let latest: unknown;
/** A time today as a time alone, and any other with its date. */
function stamp(time: string | number): string {
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
/** One reading of the worker's state: the chip's word, its tone, and a line on what follows. */
function status(
  state: Record<string, unknown>,
  report: Record<string, unknown>,
): [word: string, tone: string, line: string] {
  if (!state.configured)
    return [
      "Set up",
      "idle",
      document.getElementById("config")
        ? "Verify a connection to run a preview."
        : "Open Settings to connect Canvas and Notion.",
    ];
  if (state.running) return ["Running", "busy", `${scalarText(state.progress)}…`];
  if (state.error)
    return state.enabled
      ? ["Attention", "warn", "Automatic sync is on, but something needs attention."]
      : ["Off", "bad", "Automatic sync is off."];
  if (state.enabled) {
    const due = typeof state.nextScanAt === "number" ? state.nextScanAt : 0;
    return [
      "On",
      "good",
      `Checks run while Canvas is open. Next one ${due > Date.now() ? `after ${stamp(due)}` : "when Canvas is next in view"}.`,
    ];
  }
  if (state.previewReady)
    return report.mode === "preview"
      ? ["Ready", "info", "Preview passed. Enable sync to start automatic checks."]
      : ["Paused", "idle", "Nothing is checked until sync is enabled again."];
  return [
    "Preview",
    "idle",
    "Connected. Run Preview to see what would change; nothing is written.",
  ];
}
function say(text: string, tone = "bad"): void {
  element("message").textContent = text;
  element("message").dataset.tone = tone;
}
function render(raw: unknown): void {
  latest = raw;
  const state = object(raw),
    report = object(state.report);
  const [word, tone, line] = status(state, report);
  element("app").dataset.state = state.configured ? "ready" : "setup";
  element("chip").textContent = word;
  element("chip").dataset.tone = tone;
  element("account").textContent = scalarText(state.userId);
  element("connection").textContent = line;
  const previewed = document.getElementById("previewed");
  if (previewed) previewed.textContent = state.previewReady ? "passed" : "not run";
  const automatic = document.getElementById("automatic");
  if (automatic) automatic.textContent = state.enabled ? "on" : "off";
  // What the last scan or check left wrong has a line of its own. #message answers the last
  // action, and a stored error there would hide why that action was refused.
  const error = scalarText(state.error ?? "");
  const problem = error === element("message").textContent ? "" : error;
  if (element("problem").textContent !== problem) element("problem").textContent = problem;
  if (!filled && document.getElementById("config")) {
    input("origin").value = scalarText(state.origin ?? "");
    input("dataSourceId").value = scalarText(state.dataSourceId ?? "");
    filled = true;
  }
  // Pause and Enable sync share one place: whichever applies is the one shown.
  const pausable = Boolean(state.enabled) || Boolean(state.running);
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    const action = button.dataset.action;
    button.hidden = action === "pause" ? !pausable : action === "enable" && pausable;
    button.disabled =
      busy ||
      !state.configured ||
      (action === "sync" && (!state.enabled || Boolean(state.running))) ||
      (action === "preview" && Boolean(state.running)) ||
      (action === "enable" &&
        (!state.previewReady || Boolean(state.running) || Boolean(state.enabled)));
  }
  // The worker refuses new settings while a scan runs, so none are asked for.
  const submit = document.querySelector<HTMLButtonElement>(SUBMIT);
  if (submit) submit.disabled = busy || Boolean(state.running);
  const rows: { title: string; reason: string; outcome: string }[] = [];
  // The totals count every assignment, where the rows are capped and hold notes besides.
  const totals = OUTCOMES.map(([outcome]) => {
    const count = report[outcome];
    return typeof count === "number" ? count : 0;
  });
  let omitted = "";
  if (report.startedAt) {
    // An unfinished report with no scan running means the worker was stopped mid-scan.
    const stage = state.running ? " (running)" : report.finishedAt ? "" : " (interrupted)";
    element("summary").textContent =
      `${report.mode === "preview" ? "Preview" : "Sync"} · ${stamp(scalarText(report.finishedAt ?? report.startedAt))}${stage}`;
    if (Array.isArray(report.details))
      for (const rawDetail of report.details) {
        const detail = object(rawDetail);
        rows.push({
          title: scalarText(detail.title),
          reason: scalarText(detail.reason),
          outcome: scalarText(detail.outcome),
        });
      }
    if (typeof report.omitted === "number" && report.omitted > 0)
      omitted = `${report.omitted} more rows not shown; routine skips are left out first.`;
  } else {
    // Verifying another connection starts over, so the previous connection's scan goes too.
    element("summary").textContent = "No scans yet.";
  }
  if (element("omitted").textContent !== omitted) element("omitted").textContent = omitted;
  const rank = (outcome: string) => {
    const index = OUTCOMES.findIndex(([name]) => name === outcome);
    return index < 0 ? OUTCOMES.length : index;
  };
  rows.sort((a, b) => rank(a.outcome) - rank(b.outcome));
  const query = input("filter").value.trim().toLowerCase();
  const details = JSON.stringify([totals, rows, query, Boolean(state.running)]);
  if (details !== shownDetails) {
    shownDetails = details;
    input("filter").placeholder = `Filter ${rows.length} rows by title, reason or outcome`;
    element("stack").replaceChildren();
    element("legend").replaceChildren();
    for (const [index, [, label, , shade]] of OUTCOMES.entries()) {
      const count = totals[index] ?? 0;
      if (count <= 0) continue;
      // Drawn to scale: each part grows by its share of the assignments.
      const part = document.createElement("i");
      part.dataset.tone = shade;
      part.style.flexGrow = String(count);
      part.title = `${count} ${label}`;
      element("stack").append(part);
      const key = document.createElement("span");
      key.dataset.tone = shade;
      key.textContent = `${count} ${label}`;
      element("legend").append(key);
    }
    element("details").replaceChildren();
    let listed = 0;
    for (const row of rows) {
      const [, label, mark, shade] = OUTCOMES[rank(row.outcome)] ?? ["", row.outcome, "·", "idle"];
      if (query && !`${row.title} ${row.reason} ${label}`.toLowerCase().includes(query)) continue;
      const item = document.createElement("li");
      item.dataset.tone = shade;
      item.title = `${row.title} — ${row.reason}`;
      for (const [name, text] of [
        ["mark", mark],
        ["title", row.title],
        ["reason", row.reason],
      ] as const) {
        const cell = document.createElement("span");
        cell.className = name;
        cell.textContent = text;
        if (name === "mark") cell.ariaHidden = "true";
        item.append(cell);
      }
      element("details").append(item);
      listed++;
    }
    if (listed === 0) {
      const none = document.createElement("li");
      none.className = "none";
      none.textContent = state.running
        ? "Scanning…"
        : rows.length
          ? "No rows match."
          : report.startedAt
            ? "Nothing to report."
            : "No scans yet. Preview writes nothing.";
      element("details").append(none);
    }
  }
  // Progress lives only in the worker's memory, and no save announces it, so it is asked for.
  if (state.running) refresh(2000);
}
async function send(action: string, config?: Record<string, string>): Promise<void> {
  const raw: unknown = await chrome.runtime.sendMessage({ action, ...(config ? { config } : {}) });
  const response = object(raw);
  if (response.ok !== true)
    throw new Error(scalarText(response.error ?? "Could not reach the extension worker."));
  render(response.state);
}
async function act(action: string): Promise<void> {
  busy = true;
  say("");
  try {
    await send(action);
  } catch (error) {
    say(error instanceof Error ? error.message : "Request failed.");
  } finally {
    busy = false;
    await send("state").catch(() => undefined);
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
  button.addEventListener("click", () => {
    void act(button.dataset.action!);
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-open]")) {
  button.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
}
document.getElementById("reveal")?.addEventListener("click", () => {
  const hidden = input("token").type === "password";
  input("token").type = hidden ? "text" : "password";
  element("reveal").textContent = hidden ? "Hide" : "Show";
});
element("filter").addEventListener("input", () => {
  if (latest !== undefined) render(latest);
});
document.getElementById("config")?.addEventListener("submit", (event) => {
  event.preventDefault();
  // Checked before asking for host access, so a mistyped address is never granted any.
  const origin = canvasOrigin(input("origin").value);
  if (!origin) {
    say("Enter the Canvas HTTPS origin, without a path.");
    return;
  }
  // Until the answer renders again, so the settings cannot be sent twice.
  busy = true;
  document.querySelector<HTMLButtonElement>(SUBMIT)!.disabled = true;
  // Permissions must be requested directly from this user gesture.
  void chrome.permissions
    .request({ origins: [`${origin}/*`] })
    .then(async (granted) => {
      if (!granted) throw new Error("Canvas host access is required.");
      say("Verifying Canvas session and Notion schema…", "busy");
      await send("configure", {
        origin,
        dataSourceId: input("dataSourceId").value,
        token: input("token").value,
      });
      input("token").value = "";
      say("Connection verified. Run Preview, then Enable sync.", "good");
    })
    .catch((error: unknown) => {
      say(error instanceof Error ? error.message : "Verification failed.");
    })
    .finally(() => {
      busy = false;
      // Rendering disables it again if a scan has started meanwhile.
      document.querySelector<HTMLButtonElement>(SUBMIT)!.disabled = false;
      void send("state").catch(() => undefined);
    });
});
// Everything the worker shows outside a scan is saved, so a saved change is the time to ask.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") refresh();
});
document.addEventListener("visibilitychange", () => {
  refresh();
});
void act("state");
