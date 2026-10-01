// Registered by the worker for the configured Canvas origin only, and only while automatic sync is
// on. It reads nothing from the page and touches no DOM. It tells the worker that a Canvas page is
// in view, and the worker decides whether a scan is due.
// The worker also injects it into Canvas tabs already open when sync is enabled, and Chrome may
// inject the registered copy into the same page as well. The copy running in a page keeps its stop
// function here, so a second copy adds nothing, and the worker can stop it when sync turns off.
const scope = globalThis as typeof globalThis & { canvasWatcher?: () => void };
/**
 * Until when the worker said no scan is due, so switching tabs meanwhile does not start it only to
 * be told so again. Sync now can bring the next scan forward, but the worker never asks for more
 * than one cooldown of quiet, so that delays an automatic scan by no more than the usual wait.
 * Kept on the page's monotonic clock, so setting the system clock back cannot lengthen it.
 */
let quietUntil = 0;
/** One report at a time: a tab switch and a window focus often arrive together. */
let asking = false;
function wake(): void {
  if (document.visibilityState !== "visible" || asking || performance.now() < quietUntil) return;
  asking = true;
  // A worker that is reloading misses nothing a later signal cannot give. It answers stop when
  // sync is off or moved to another Canvas, for a page it could not reach when that happened.
  chrome.runtime
    .sendMessage({ action: "wake" })
    .then(
      (reply?: { stop?: boolean; quiet?: number }) => {
        if (reply?.stop) quit();
        else if (typeof reply?.quiet === "number") quietUntil = performance.now() + reply.quiet;
      },
      () => undefined,
    )
    .finally(() => {
      asking = false;
    });
}
// A page restored from the back-forward cache keeps this script without running it again.
function restored(event: PageTransitionEvent): void {
  if (event.persisted) wake();
}
function quit(): void {
  window.removeEventListener("pageshow", restored);
  document.removeEventListener("visibilitychange", wake);
  window.removeEventListener("focus", wake);
  delete scope.canvasWatcher;
}
if (!scope.canvasWatcher) {
  scope.canvasWatcher = quit;
  // Injected once the page has loaded, so this stands for the load itself.
  wake();
  window.addEventListener("pageshow", restored);
  // Switching to this tab, and the window regaining focus while this tab is shown in it.
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
}
