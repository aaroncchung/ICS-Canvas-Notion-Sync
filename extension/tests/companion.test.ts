/* eslint @typescript-eslint/require-await: "off", @typescript-eslint/unbound-method: "off" -- Async API doubles and Vitest spy assertions. */
import { describe, expect, it, vi } from "vitest";
import { Api, ApiError, type SyncApi } from "../src/api.ts";
import { scan, serialExecutor } from "../src/engine.ts";
import {
  completion,
  alreadyHandled,
  newReport,
  targetFromPage,
  targetKey,
  type Report,
  type Target,
} from "../src/model.ts";
import { classifyEvent } from "../../src/canvas/classify-event.ts";

const config = {
  origin: "https://school.instructure.com",
  token: "test-token",
  dataSourceId: "12345678-1234-1234-1234-123456789012",
  userId: "7",
  enabled: true,
};
function page(uid = "event-assignment-123", url: string | null = null) {
  return {
    id: "page-123",
    parent: { data_source_id: config.dataSourceId },
    properties: {
      Assignment: { title: [{ plain_text: "Homework" }] },
      "Canvas UID": { rich_text: [{ plain_text: uid }] },
      "Canvas URL": { url },
      "Imported From": { type: "select", select: { name: "Canvas ICS" } },
      "Personal Status": { status: { name: "In progress" } },
      "Canvas State": { select: { name: "Active" } },
      "Removed from Canvas": { checkbox: false },
    },
  };
}
function target(overrides: Partial<Target> = {}): Target {
  return { ...targetFromPage(page())!, ...overrides };
}
function submission(overrides: Record<string, unknown> = {}) {
  return {
    assignment_id: 123,
    user_id: 7,
    workflow_state: "submitted",
    attempt: 1,
    submitted_at: "2026-09-21T12:00:00Z",
    missing: false,
    ...overrides,
  };
}
/** Course 42 is active and holds assignment 123; course 43 is only a completed enrollment. */
function fixture() {
  const acknowledged: Record<string, string> = {};
  const saveAcknowledged = vi.fn(async () => undefined);
  let current = target();
  const api: SyncApi = {
    user: vi.fn(async () => "7"),
    validateSchema: vi.fn(async () => undefined),
    targets: vi.fn(async () => ({ items: [target()] })),
    courses: vi.fn(async (enrollment) => ({
      items: enrollment === "active" ? ["42"] : ["42", "43"],
    })),
    assignments: vi.fn(async (courseId) => ({
      items: courseId === "42" ? [{ id: 123, course_id: 42, submission: submission() }] : [],
    })),
    target: vi.fn(async () => current),
    markDone: vi.fn(async () => {
      current = { ...current, status: "Done" };
    }),
  };
  return {
    api,
    acknowledged,
    saveAcknowledged,
    run: async (mode: Report["mode"] = "sync") => {
      const report = newReport(mode, Date.now());
      await scan(config, report, {
        api,
        acknowledged,
        saveAcknowledged,
        progress: () => undefined,
      });
      return report;
    },
    reopen: () => {
      current = { ...current, status: "In progress" };
    },
  };
}

describe("identity and completion", () => {
  it("does not treat timestamp edits, excusal or an older attempt as a new submission", () => {
    const original = completion(submission(), "42", "7")!.evidence;
    expect(
      alreadyHandled(
        original,
        completion(submission({ submitted_at: "2026-09-22T12:00:00Z" }), "42", "7")!.evidence,
      ),
    ).toBe(true);
    expect(alreadyHandled(original, "completion")).toBe(true);
    expect(alreadyHandled("attempt:2", "attempt:1")).toBe(true);
    expect(alreadyHandled("attempt:1", "attempt:2")).toBe(false);
  });
  it("matches real-feed-shaped UID-only records without changing classifier behavior", () => {
    expect(target().assignmentId).toBe("123");
    expect(
      classifyEvent({
        uid: "event-assignment-123",
        url: "https://school.edu/calendar#assignment_123",
      }),
    ).toMatchObject({ kind: "assignment", canvasAssignmentId: "123" });
    expect(
      targetFromPage(page("event-assignment-123", "https://vanity.edu/courses/42/assignments/123")),
    ).toMatchObject({ assignmentId: "123", courseId: "42", conflict: false });
    expect(
      targetFromPage(page("unrecognized", "https://vanity.edu/courses/42/assignments/123"))
        ?.assignmentId,
    ).toBe("123");
    expect(
      targetFromPage(page("event-assignment-999", "https://vanity.edu/courses/42/assignments/123"))
        ?.conflict,
    ).toBe(true);
    expect(
      classifyEvent({
        uid: "event-assignment-999",
        url: "https://vanity.edu/courses/42/assignments/123",
      }).canvasAssignmentId,
    ).toBe("123");
  });
  it.each([
    [{}, true],
    [{ workflow_state: "unsubmitted", submitted_at: null, attempt: null }, false],
    [{ workflow_state: "graded", submitted_at: null, attempt: null, score: 0 }, true],
    [{ workflow_state: "graded", submitted_at: null, score: 0, missing: true }, false],
    [
      { workflow_state: "graded", submitted_at: null, score: 0, late_policy_status: "missing" },
      false,
    ],
    [{ workflow_state: "unsubmitted", submitted_at: null, excused: true, missing: true }, true],
    [{ redo_request: true }, false],
    [{ missing: true }, true],
  ])("classifies completion conservatively: %j", (override, eligible) => {
    expect(completion(submission(override), "42", "7")?.eligible).toBe(eligible);
  });
  it("rejects malformed and other-user records; grade changes retain evidence identity", () => {
    expect(completion(submission({ user_id: 8 }), "42", "7")).toBeUndefined();
    expect(completion(submission({ missing: "false" }), "42", "7")).toBeUndefined();
    expect(completion(submission({ workflow_state: "unknown" }), "42", "7")).toBeUndefined();
    expect(
      completion(submission({ score: 80, workflow_state: "graded" }), "42", "7")?.evidence,
    ).toBe(completion(submission(), "42", "7")?.evidence);
  });
});

describe("scan", () => {
  it("marks once, respects reopening, handles a new attempt, and leaves past courses alone", async () => {
    const { api, run, reopen, saveAcknowledged } = fixture();
    expect((await run()).updated).toBe(1);
    expect(saveAcknowledged).toHaveBeenCalledTimes(1);
    expect(api.courses).not.toHaveBeenCalledWith("completed", undefined);
    expect(api.assignments).toHaveBeenCalledTimes(1);
    reopen();
    expect((await run()).skipped).toBe(1);
    expect(api.markDone).toHaveBeenCalledTimes(1);
    api.assignments = vi.fn(async () => ({
      items: [
        {
          id: 123,
          course_id: 42,
          submission: submission({ attempt: 2, submitted_at: "2026-09-22T12:00:00Z" }),
        },
      ],
    }));
    await run();
    expect(api.markDone).toHaveBeenCalledTimes(2);
  });
  it("reads completed courses while an assignment is unaccounted for, visiting each course once", async () => {
    const { api, run } = fixture();
    api.assignments = vi.fn(async (courseId) => ({
      items: courseId === "43" ? [{ id: 123, course_id: 43, submission: submission() }] : [],
    }));
    expect((await run()).updated).toBe(1);
    expect(api.courses).toHaveBeenCalledWith("completed", undefined);
    expect(vi.mocked(api.assignments).mock.calls.map(([courseId]) => courseId)).toEqual([
      "42",
      "43",
    ]);
  });
  it("follows pagination for Notion pages, courses and assignments", async () => {
    const { api, run } = fixture();
    api.courses = vi.fn(async (_enrollment, cursor) =>
      cursor ? { items: ["42"] } : { items: ["41"], next: "courses2" },
    );
    api.assignments = vi.fn(async (courseId, cursor) =>
      courseId === "42" && !cursor
        ? { items: [], next: "page2" }
        : {
            items: courseId === "42" ? [{ id: 123, course_id: 42, submission: submission() }] : [],
          },
    );
    expect((await run()).updated).toBe(1);
    expect(api.assignments).toHaveBeenCalledWith("42", "page2");
  });
  it("preview does not write or consume completion history", async () => {
    const { api, run, acknowledged, saveAcknowledged } = fixture();
    expect((await run("preview")).eligible).toBe(1);
    expect(api.markDone).not.toHaveBeenCalled();
    expect(acknowledged).toEqual({});
    expect(saveAcknowledged).not.toHaveBeenCalled();
  });
  it("reads all Notion pages before detecting duplicate identities", async () => {
    const { api, run } = fixture();
    api.targets = vi.fn(async (cursor) =>
      cursor ? { items: [target({ pageId: "duplicate" })] } : { items: [target()], next: "next" },
    );
    expect((await run()).skipped).toBe(2);
    expect(api.markDone).not.toHaveBeenCalled();
  });
  it("skips removed, missing and conflicting identities and checks course hints", async () => {
    const { api, run } = fixture();
    api.targets = vi.fn(async () => ({
      items: [
        target({ courseId: "99" }),
        target({ assignmentId: "", pageId: "missing" }),
        target({ assignmentId: "2", removed: true }),
        target({ assignmentId: "3", conflict: true }),
      ],
    }));
    expect((await run()).skipped).toBe(4);
    expect(api.markDone).not.toHaveBeenCalled();
  });
  it("retries a write that did not land on the next scan instead of parking the page", async () => {
    const { api, run, acknowledged } = fixture();
    const markDone = vi.mocked(api.markDone);
    markDone.mockRejectedValueOnce(new ApiError("Notion", 0));
    await expect(run()).rejects.toBeInstanceOf(ApiError);
    expect(acknowledged).toEqual({});
    expect((await run("preview")).eligible).toBe(1);
    expect((await run()).updated).toBe(1);
    expect(markDone).toHaveBeenCalledTimes(2);
  });
  it("acknowledges a write that landed despite a lost response, then preserves a reopening", async () => {
    const { api, run, reopen, acknowledged } = fixture();
    const landed = vi.mocked(api.markDone).getMockImplementation()!;
    vi.mocked(api.markDone).mockImplementationOnce(async (pageId) => {
      await landed(pageId);
      throw new ApiError("Notion", 0);
    });
    await expect(run()).rejects.toBeInstanceOf(ApiError);
    expect((await run()).skipped).toBe(1);
    expect(acknowledged[targetKey(target())]).toBe("attempt:1");
    reopen();
    await run();
    expect(api.markDone).toHaveBeenCalledTimes(1);
  });
  it("reports a page Notion refuses and carries on", async () => {
    const { api, run, acknowledged } = fixture();
    vi.mocked(api.markDone).mockRejectedValueOnce(new ApiError("Notion", 403));
    const report = await run();
    expect(report.failed).toBe(1);
    expect(report.details[0]?.reason).toContain("HTTP 403");
    expect(acknowledged).toEqual({});
  });
  it("does not write if the destination or the signed-in account changed", async () => {
    const changed = fixture();
    changed.api.target = vi.fn(async () => target({ uid: "event-assignment-999" }));
    expect((await changed.run()).skipped).toBe(1);
    expect(changed.api.markDone).not.toHaveBeenCalled();
    const switched = fixture();
    // The account is checked when the scan starts and again at the first write.
    switched.api.user = vi.fn<SyncApi["user"]>().mockResolvedValueOnce("7").mockResolvedValue("8");
    await expect(switched.run()).rejects.toThrow("account changed");
    expect(switched.api.markDone).not.toHaveBeenCalled();
  });
  it("reports an inaccessible course as unchecked but stops on an outage", async () => {
    const { api, run } = fixture();
    api.assignments = vi.fn(async () => {
      throw new ApiError("Canvas", 403);
    });
    const report = await run();
    expect(report.unchecked).toBe(1);
    expect(report.details.map((detail) => detail.title)).toContain("Course 42");
    expect(api.markDone).not.toHaveBeenCalled();
    api.assignments = vi.fn(async () => {
      throw new ApiError("Canvas", 503);
    });
    await expect(run()).rejects.toBeInstanceOf(ApiError);
  });
  it("serializes overlapping triggers and recovers the queue after rejection", async () => {
    const serial = serialExecutor(),
      order: number[] = [];
    await Promise.allSettled([
      serial(async () => {
        await Promise.resolve();
        order.push(1);
        throw new Error();
      }),
      serial(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe("HTTP boundary", () => {
  function setup(responses: Response[], signal?: AbortSignal) {
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
    const pause = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    return {
      api: new Api(config, { fetcher, pause, ...(signal ? { signal } : {}) }),
      fetcher,
      pause,
    };
  }
  const json = (data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", ...headers },
    });
  it("uses session credentials only for Canvas and writes only Personal Status", async () => {
    const { api, fetcher } = setup([json({ id: 7 }), json(page())]);
    await api.user();
    await api.markDone("page-123");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "include", redirect: "error" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit", method: "PATCH" });
    expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({
      properties: { "Personal Status": { status: { name: "Done" } } },
    });
  });
  it("rejects foreign-host and different-endpoint pagination before fetching it", async () => {
    for (const next of [
      "https://evil.test/api/v1/courses?page=2",
      "https://school.instructure.com/api/v1/users",
    ]) {
      const { api, fetcher } = setup([json([], { Link: `<${next}>; rel="next"` })]);
      await expect(api.courses("active")).rejects.toThrow("pagination destination");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("follows Canvas and Notion pagination and rejects login HTML", async () => {
    const { api, fetcher } = setup([
      json([{ id: 42 }, { id: 44, access_restricted_by_date: true }], {
        Link: '<https://school.instructure.com/api/v1/courses?page=2>; rel="next"',
      }),
      json([{ id: 43 }]),
      json({ results: [page()], has_more: true, next_cursor: "cursor" }),
      new Response("<html>Login</html>", { headers: { "Content-Type": "text/html" } }),
    ]);
    const first = await api.courses("active");
    expect(first.items).toEqual(["42"]);
    expect((await api.courses("active", first.next)).items).toEqual(["43"]);
    expect((await api.targets()).next).toBe("cursor");
    await expect(api.user()).rejects.toBeInstanceOf(ApiError);
    // A login page is not transient, so it is not retried.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rejects destination pages moved into another data source or deleted", async () => {
    const raw = page();
    raw.parent.data_source_id = "another";
    const { api } = setup([json(raw), new Response("{}", { status: 404 })]);
    expect(await api.target("page-123")).toBeUndefined();
    expect(await api.target("page-123")).toBeUndefined();
  });
  it("retries transient failures, honors Retry-After, and gives up after two retries", async () => {
    const busy = () => new Response("", { status: 503 });
    const recovered = setup([
      busy(),
      new Response("", { status: 429, headers: { "Retry-After": "5" } }),
      json({ id: 7 }),
    ]);
    expect(await recovered.api.user()).toBe("7");
    expect(recovered.pause.mock.calls.map(([ms]) => ms)).toContain(5000);
    const down = setup([busy(), busy(), busy(), json({ id: 7 })]);
    await expect(down.api.user()).rejects.toMatchObject({ status: 503 });
    expect(down.fetcher).toHaveBeenCalledTimes(3);
    const throttled = setup([
      new Response("", { status: 429, headers: { "Retry-After": "600" } }),
      json({ id: 7 }),
    ]);
    await expect(throttled.api.user()).rejects.toMatchObject({ status: 429, retryAfter: 600_000 });
    expect(throttled.fetcher).toHaveBeenCalledTimes(1);
    const refused = setup([new Response("", { status: 401 }), json({ id: 7 })]);
    await expect(refused.api.user()).rejects.toMatchObject({ status: 401 });
    expect(refused.fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends nothing once the scan has been cancelled", async () => {
    const controller = new AbortController();
    const { api, fetcher } = setup([json({ id: 7 })], controller.signal);
    controller.abort();
    await expect(api.user()).rejects.not.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
