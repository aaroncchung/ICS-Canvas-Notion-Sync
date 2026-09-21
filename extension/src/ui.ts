import { canvasOrigin, object, scalarText } from "./model.ts";

const element = (id: string): HTMLElement => document.getElementById(id)!;
const input = (id: string): HTMLInputElement => element(id) as HTMLInputElement;
let filled = false;
let busy = false;
let shownError = "";
function render(raw: unknown): void {
  const state = object(raw),
    report = object(state.report);
  element("connection").textContent = state.configured
    ? `${state.enabled ? "Automatic sync on" : "Paused"} · Canvas account ${scalarText(state.userId)}${state.running ? ` · ${scalarText(state.progress)}…` : ""}`
    : "Open Settings to connect Canvas and Notion.";
  const error = scalarText(state.error ?? "");
  if (error) element("message").textContent = shownError = error;
  else if (shownError && element("message").textContent === shownError)
    element("message").textContent = shownError = "";
  if (!filled && document.getElementById("config")) {
    input("origin").value = scalarText(state.origin ?? "");
    input("dataSourceId").value = scalarText(state.dataSourceId ?? "");
    filled = true;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    const action = button.dataset.action;
    button.disabled =
      busy ||
      !state.configured ||
      (action === "sync" && (!state.enabled || Boolean(state.running))) ||
      (action === "preview" && Boolean(state.running)) ||
      (action === "enable" &&
        (!state.previewReady || Boolean(state.running) || Boolean(state.enabled)));
  }
  if (report.startedAt) {
    // An unfinished report with no scan running means the worker was stopped mid-scan.
    const stage = state.running ? " (running)" : report.finishedAt ? "" : " (interrupted)";
    element("summary").textContent =
      `${report.mode === "preview" ? "Preview" : "Sync"} · ${new Date(scalarText(report.finishedAt ?? report.startedAt)).toLocaleString()}${stage}\n${scalarText(report.updated)} updated · ${scalarText(report.eligible)} eligible · ${scalarText(report.skipped)} skipped · ${scalarText(report.unchecked)} unchecked · ${scalarText(report.failed)} failed`;
    element("details").replaceChildren();
    const row = (text: string) => {
      const item = document.createElement("li");
      item.textContent = text;
      element("details").append(item);
    };
    if (Array.isArray(report.details))
      for (const rawDetail of report.details) {
        const detail = object(rawDetail);
        row(`${scalarText(detail.title)} — ${scalarText(detail.reason)}`);
      }
    if (typeof report.omitted === "number" && report.omitted > 0)
      row(`${report.omitted} more rows not shown; routine skips are left out first.`);
  } else {
    // Verifying another connection starts over, so the previous connection's scan goes too.
    element("summary").textContent = "No scans yet.";
    element("details").replaceChildren();
  }
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
  element("message").textContent = "";
  try {
    await send(action);
  } catch (error) {
    element("message").textContent = error instanceof Error ? error.message : "Request failed.";
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
document.getElementById("settings")?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});
document.getElementById("config")?.addEventListener("submit", (event) => {
  event.preventDefault();
  // Checked before asking for host access, so a mistyped address is never granted any.
  const origin = canvasOrigin(input("origin").value);
  if (!origin) {
    element("message").textContent = "Enter the Canvas HTTPS origin, without a path.";
    return;
  }
  // Permissions must be requested directly from this user gesture.
  void chrome.permissions
    .request({ origins: [`${origin}/*`] })
    .then(async (granted) => {
      if (!granted) throw new Error("Canvas host access is required.");
      busy = true;
      element("message").textContent = "Verifying Canvas session and Notion schema…";
      await send("configure", {
        origin,
        dataSourceId: input("dataSourceId").value,
        token: input("token").value,
      });
      input("token").value = "";
      element("message").textContent = "Connection verified. Run Preview, then Enable sync.";
    })
    .catch((error: unknown) => {
      element("message").textContent =
        error instanceof Error ? error.message : "Verification failed.";
    })
    .finally(() => {
      busy = false;
      void send("state").catch(() => undefined);
    });
});
void act("state");
setInterval(() => {
  if (!busy) void send("state").catch(() => undefined);
}, 2000);
