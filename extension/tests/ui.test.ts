/* eslint @typescript-eslint/require-await: "off" -- Chrome promise doubles. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import options from "../static/options.html?raw";
import popup from "../static/popup.html?raw";

/** The part of an element ui.ts touches. */
class FakeElement {
  textContent = "";
  value = "";
  disabled = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners[type] = listener;
  }
  replaceChildren() {
    this.children = [];
  }
  append(child: FakeElement) {
    this.children.push(child);
  }
}
const pages = { popup, options };
let byId: Map<string, FakeElement>;
let actions: FakeElement[];
let submit: FakeElement | undefined;
/** What the worker holds, as its `view` shows it. */
let state: Record<string, unknown>;
/** The worker's answer to each action other than "state"; by default it succeeds. */
let answer: (action: string) => Record<string, unknown>;
/** The user's answer to the host access prompt, once they give it. */
let grant: Promise<boolean>;
/** Whether the worker answers at all. */
let reachable: boolean;
let request: ReturnType<typeof vi.fn>;

/** Loads the page's script into a document with the elements the page's HTML declares. */
async function open(page: keyof typeof pages) {
  const html = pages[page];
  byId = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id!, new FakeElement()]));
  actions = [...html.matchAll(/\bdata-action="([^"]+)"/g)].map(([, action]) => {
    const button = new FakeElement();
    button.dataset.action = action!;
    return button;
  });
  submit = html.includes('type="submit"') ? new FakeElement() : undefined;
  vi.stubGlobal("document", {
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (selector: string) => (selector === "button[data-action]" ? actions : []),
    querySelector: (selector: string) =>
      selector === "#config button[type=submit]" ? (submit ?? null) : null,
    createElement: () => new FakeElement(),
  });
  await import("../src/ui.ts");
  await settle();
}
/** Lets pending replies arrive, well inside the 2-second poll. */
const settle = () => vi.advanceTimersByTimeAsync(100);
const text = (id: string) => byId.get(id)!.textContent;
const button = (action: string) => actions.find((item) => item.dataset.action === action)!;
async function click(action: string) {
  button(action).listeners.click!({ preventDefault: () => undefined });
  await settle();
}
async function save(origin: string, dataSourceId = "12345678-1234-1234-1234-123456789012") {
  byId.get("origin")!.value = origin;
  byId.get("dataSourceId")!.value = dataSourceId;
  byId.get("config")!.listeners.submit!({ preventDefault: () => undefined });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  state = {
    configured: true,
    origin: "https://canvas.test",
    dataSourceId: "12345678-1234-1234-1234-123456789012",
    userId: "7",
    enabled: false,
    previewReady: true,
    running: false,
  };
  answer = () => ({ ok: true });
  grant = Promise.resolve(true);
  reachable = true;
  request = vi.fn(() => grant);
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: async ({ action }: { action: string }) => {
        if (!reachable) throw new Error("Could not establish connection.");
        const reply = action === "state" ? { ok: true } : answer(action);
        return reply.ok ? { ...reply, state: structuredClone(state) } : reply;
      },
      openOptionsPage: vi.fn(async () => undefined),
    },
    permissions: { request },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("popup and settings", () => {
  it("keeps an action's own error in view while an earlier scan's error stands", async () => {
    state.error = "Canvas: HTTP 401";
    await open("popup");
    expect(text("problem")).toBe("Canvas: HTTP 401");
    const refused = "Canvas host access was removed. Allow that site for the extension.";
    answer = () => ({ ok: false, error: refused });
    await click("enable");
    expect(text("message")).toBe(refused);
    expect(text("problem")).toBe("Canvas: HTTP 401");
    // The poll that follows does not replace it either.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(text("message")).toBe(refused);
    // Once the stored error is gone, its line empties and the action's answer stays.
    delete state.error;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(text("problem")).toBe("");
    expect(text("message")).toBe(refused);
  });
  it("shows why Verify and save was refused, and a stored error only once", async () => {
    state.error = "Canvas: HTTP 401";
    await open("options");
    answer = () => ({ ok: false, error: "Enter a Notion data-source ID (UUID)." });
    await save("https://canvas.test", "not-a-uuid");
    expect(text("message")).toBe("Enter a Notion data-source ID (UUID).");
    expect(text("problem")).toBe("Canvas: HTTP 401");
    // Verifying the saved connection again can fail with the very error it stored.
    answer = () => ({ ok: false, error: "Canvas: HTTP 401" });
    await save("https://canvas.test");
    expect(text("message")).toBe("Canvas: HTTP 401");
    expect(text("problem")).toBe("");
  });
  it("asks no host access for a wildcard or any other host that is not a hostname", async () => {
    await open("options");
    for (const origin of ["https://*", "https://*.edu", "https://canvas.*.edu"]) {
      await save(origin);
      expect(text("message")).toContain("Canvas HTTPS origin");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("locks Verify and save from the moment it is sent until the answer comes", async () => {
    await open("options");
    let decide!: (granted: boolean) => void;
    grant = new Promise((resolve) => {
      decide = resolve;
    });
    await save("https://other.test");
    // Still waiting on the host access prompt.
    expect(request).toHaveBeenCalledWith({ origins: ["https://other.test/*"] });
    expect(submit?.disabled).toBe(true);
    decide(true);
    await settle();
    expect(text("message")).toContain("Connection verified");
    expect(submit?.disabled).toBe(false);
    grant = Promise.resolve(false);
    await save("https://other.test");
    expect(text("message")).toBe("Canvas host access is required.");
    expect(submit?.disabled).toBe(false);
    // Nor does a worker that cannot be reached leave it locked.
    grant = Promise.resolve(true);
    reachable = false;
    await save("https://other.test");
    expect(text("message")).toContain("Could not establish connection");
    expect(submit?.disabled).toBe(false);
  });
  it("offers Verify and save only while no scan runs", async () => {
    state.running = true;
    await open("options");
    expect(submit?.disabled).toBe(true);
    state.running = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(submit?.disabled).toBe(false);
  });
});
