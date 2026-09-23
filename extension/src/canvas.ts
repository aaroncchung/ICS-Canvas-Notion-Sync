// Registered by the worker for the configured Canvas origin only, and only while automatic sync is
// on. It reads nothing from the page and touches no DOM. It tells the worker that a Canvas page is
// in view, and the worker decides whether a scan is due.
function wake(): void {
  if (document.visibilityState !== "visible") return;
  // No answer comes back, and a worker that is reloading misses nothing a later signal cannot give.
  void chrome.runtime.sendMessage({ action: "wake" }).catch(() => undefined);
}
// Injected once the page has loaded, so this stands for the load itself. A page restored from the
// back-forward cache keeps this script without running it again.
wake();
window.addEventListener("pageshow", (event) => {
  if (event.persisted) wake();
});
// Switching to this tab, and the window regaining focus while this tab is shown in it.
document.addEventListener("visibilitychange", wake);
window.addEventListener("focus", wake);
