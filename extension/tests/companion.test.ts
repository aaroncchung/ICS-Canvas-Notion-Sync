/* eslint @typescript-eslint/require-await: "off", @typescript-eslint/unbound-method: "off" -- Async API doubles and Vitest spy assertions. */
import { describe, expect, it, vi } from "vitest";
import { Api, ApiError, type SyncApi } from "../src/api.ts";
import { scan, serialExecutor, WriteAccessDenied } from "../src/engine.ts";
import {
  completion,
  alreadyHandled,
  newReport,
  record,
  note,
  targetFromPage,
  targetKey,
  UserError,
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
/** Number.MAX_SAFE_INTEGER + 2: a valid 64-bit Canvas ID that a JSON number cannot hold exactly. */
const BIG_ID = "9007199254740993";
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
      items:
        courseId === "42"
          ? [{ id: 123, name: "Homework", course_id: 42, submission: submission() }]
          : [],
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
    // Complete/incomplete grading: "incomplete" comes with a score of 0 and means still owed.
    [{ workflow_state: "graded", submitted_at: null, attempt: null, grade: "complete" }, true],
    [
      {
        workflow_state: "graded",
        submitted_at: null,
        attempt: null,
        grade: "Incomplete",
        score: 0,
      },
      false,
    ],
    [{ workflow_state: "graded", grade: "incomplete", score: 0 }, true],
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
  it("keeps the rows worth reading when a scan has more rows than the report holds", () => {
    const report = newReport("preview", 0);
    for (let index = 0; index < 150; index++)
      record(report, { title: `Routine ${index}` }, "skipped", "No completion evidence");
    note(report, "Course 41", "unchecked", "Not accessible");
    record(report, { title: "Essay" }, "eligible", "Submitted");
    record(report, { title: "Quiz" }, "failed", "Notion: HTTP 400");
    note(report, "Scan", "skipped", "Paused before finishing", 0);
    expect(report.details).toHaveLength(100);
    expect(report.details.slice(-4).map((detail) => detail.title)).toEqual([
      "Course 41",
      "Essay",
      "Quiz",
      "Scan",
    ]);
    // The totals still count every assignment, and the report says how many rows it left out.
    expect(report).toMatchObject({ skipped: 150, eligible: 1, failed: 1, omitted: 54 });
    // A routine row never displaces anything, and nothing displaces a failure.
    record(report, { title: "Late routine" }, "skipped", "Already Done");
    expect(report.details.at(-1)?.title).toBe("Scan");
    const failures = newReport("sync", 0);
    for (let index = 0; index < 101; index++)
      record(failures, { title: `Failure ${index}` }, "failed", "Notion: HTTP 400");
    expect(failures.details.at(-1)?.title).toBe("Failure 99");
  });
  it("keeps 64-bit Canvas IDs exact as strings and never trusts a number JSON cannot represent", () => {
    expect(Number(BIG_ID)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(targetFromPage(page(`event-assignment-${BIG_ID}`))?.assignmentId).toBe(BIG_ID);
    expect(completion(submission({ user_id: BIG_ID }), "42", BIG_ID)?.eligible).toBe(true);
    // Parsed as a number this ID is rounded to a neighbor, so it must not match anything.
    expect(completion(submission({ user_id: Number(BIG_ID) }), "42", BIG_ID)).toBeUndefined();
  });
});

describe("scan", () => {
  it("matches users, courses and assignments whose IDs exceed Number.MAX_SAFE_INTEGER", async () => {
    const { api } = fixture();
    const big = target({ assignmentId: BIG_ID, uid: `event-assignment-${BIG_ID}` });
    api.user = vi.fn(async () => BIG_ID);
    api.targets = vi.fn(async () => ({ items: [big] }));
    api.courses = vi.fn(async () => ({ items: [BIG_ID] }));
    api.assignments = vi.fn(async () => ({
      items: [
        {
          id: BIG_ID,
          name: "Homework",
          course_id: BIG_ID,
          submission: submission({ assignment_id: BIG_ID, user_id: BIG_ID }),
        },
      ],
    }));
    api.target = vi.fn(async () => big);
    const report = newReport("sync", Date.now());
    await scan({ ...config, userId: BIG_ID }, report, {
      api,
      acknowledged: {},
      saveAcknowledged: async () => undefined,
      progress: () => undefined,
    });
    expect(report.updated).toBe(1);
    expect(api.assignments).toHaveBeenCalledWith(BIG_ID, undefined);
  });
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
          name: "Homework",
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
      items:
        courseId === "43"
          ? [{ id: 123, name: "Homework", course_id: 43, submission: submission() }]
          : [],
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
            items:
              courseId === "42"
                ? [{ id: 123, name: "Homework", course_id: 42, submission: submission() }]
                : [],
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
    vi.mocked(api.markDone).mockRejectedValueOnce(new ApiError("Notion", 400));
    const report = await run();
    expect(report.failed).toBe(1);
    expect(report.details[0]?.reason).toContain("HTTP 400");
    expect(acknowledged).toEqual({});
  });
  it("treats a refused write to a readable page as missing write access, not a bad page", async () => {
    const { api, run, acknowledged } = fixture();
    vi.mocked(api.markDone).mockRejectedValueOnce(new ApiError("Notion", 403));
    await expect(run()).rejects.toBeInstanceOf(WriteAccessDenied);
    await expect(run()).resolves.toMatchObject({ updated: 1 });
    expect(acknowledged[targetKey(target())]).toBe("attempt:1");
  });
  it("writes only where the Notion title is the Canvas assignment's name", async () => {
    // Assignment 123 exists in this Canvas too, but it is some other piece of work.
    const foreign = fixture();
    foreign.api.assignments = vi.fn(async () => ({
      items: [{ id: 123, name: "Lab report", course_id: 42, submission: submission() }],
    }));
    for (const mode of ["preview", "sync"] as const) {
      const report = await foreign.run(mode);
      expect(report).toMatchObject({ skipped: 1, eligible: 0, updated: 0 });
      expect(report.details[0]?.reason).toContain("Title differs");
    }
    expect(foreign.api.target).not.toHaveBeenCalled();
    expect(foreign.api.markDone).not.toHaveBeenCalled();
    expect(foreign.acknowledged).toEqual({});
    // A missing name or title proves nothing either.
    const unnamed = fixture();
    unnamed.api.assignments = vi.fn(async () => ({
      items: [{ id: 123, course_id: 42, submission: submission() }],
    }));
    expect((await unnamed.run()).skipped).toBe(1);
    const untitled = fixture();
    untitled.api.targets = vi.fn(async () => ({ items: [target({ title: "" })] }));
    untitled.api.assignments = vi.fn(async () => ({
      items: [{ id: 123, name: "", course_id: 42, submission: submission() }],
    }));
    expect((await untitled.run()).skipped).toBe(1);
    // Spacing, case and Unicode form are not differences.
    const respaced = fixture();
    respaced.api.assignments = vi.fn(async () => ({
      items: [{ id: 123, name: "  HOMEＷORK ", course_id: 42, submission: submission() }],
    }));
    expect((await respaced.run()).updated).toBe(1);
    // The title is checked again on the page as it is just before the write.
    const retitled = fixture();
    retitled.api.target = vi.fn(async () => target({ title: "Lab report" }));
    expect((await retitled.run()).skipped).toBe(1);
    expect(retitled.api.markDone).not.toHaveBeenCalled();
  });
  it("acknowledges a page the query already shows as Done without reading it again", async () => {
    const { api, run, acknowledged } = fixture();
    api.targets = vi.fn(async () => ({ items: [target({ status: "Done" })] }));
    expect((await run("preview")).skipped).toBe(1);
    expect(acknowledged).toEqual({});
    const report = await run();
    expect(report.details[0]?.reason).toBe("Already Done");
    expect(acknowledged[targetKey(target())]).toBe("attempt:1");
    expect(api.target).not.toHaveBeenCalled();
    expect(api.markDone).not.toHaveBeenCalled();
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
  it("keeps one broken course from holding back the others", async () => {
    for (const failure of [
      new ApiError("Canvas", 503),
      new UserError("Canvas pagination did not advance"),
    ]) {
      const { api, run } = fixture();
      api.courses = vi.fn(async () => ({ items: ["41", "42"] }));
      const working = api.assignments;
      api.assignments = vi.fn<SyncApi["assignments"]>(async (courseId, cursor) => {
        if (courseId === "41") throw failure;
        return working(courseId, cursor);
      });
      const report = await run();
      expect(report.updated).toBe(1);
      expect(report.details).toContainEqual({
        title: "Course 41",
        outcome: "unchecked",
        reason: `Could not be read (${failure.message})`,
      });
    }
  });
  it("ends the scan when Canvas throttles or the network fails, which is not about one course", async () => {
    for (const failure of [
      new ApiError("Canvas", 403, 0, "rate limit exceeded", true),
      new ApiError("Canvas", 429),
      new ApiError("Canvas", 0),
    ]) {
      const { api, run } = fixture();
      api.courses = vi.fn(async () => ({ items: ["41", "42"] }));
      api.assignments = vi.fn(async () => {
        throw failure;
      });
      await expect(run()).rejects.toBe(failure);
      expect(api.assignments).toHaveBeenCalledTimes(1);
    }
  });
  it("tells a course that answers 401 from a session that expired during the scan", async () => {
    const forbidden = fixture();
    forbidden.api.courses = vi.fn(async () => ({ items: ["41", "42"] }));
    const working = forbidden.api.assignments;
    forbidden.api.assignments = vi.fn<SyncApi["assignments"]>(async (courseId, cursor) => {
      if (courseId === "41") throw new ApiError("Canvas", 401);
      return working(courseId, cursor);
    });
    const report = await forbidden.run();
    expect(report.updated).toBe(1);
    expect(report.details[0]).toMatchObject({ title: "Course 41", outcome: "unchecked" });
    const expired = fixture();
    const signedOut = new ApiError("Canvas", 401);
    expired.api.user = vi
      .fn<SyncApi["user"]>()
      .mockResolvedValueOnce("7")
      .mockRejectedValue(signedOut);
    expired.api.assignments = vi.fn(async () => {
      throw new ApiError("Canvas", 401);
    });
    await expect(expired.run()).rejects.toBe(signedOut);
    expect(expired.api.markDone).not.toHaveBeenCalled();
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
  it("asks Canvas for string IDs so 64-bit IDs survive, and rejects a rounded numeric ID", async () => {
    const { api, fetcher } = setup([
      json({ id: BIG_ID }),
      json([{ id: BIG_ID }]),
      json({ results: [], has_more: false }),
      // The raw wire form of a server that ignored the request for string IDs.
      new Response(`{"id":${BIG_ID}}`, { headers: { "Content-Type": "application/json" } }),
    ]);
    expect(await api.user()).toBe(BIG_ID);
    expect((await api.courses("active")).items).toEqual([BIG_ID]);
    await api.targets();
    const accept = (call: number) =>
      (fetcher.mock.calls[call]?.[1]?.headers as Record<string, string>).Accept;
    expect(accept(0)).toBe("application/json+canvas-string-ids");
    expect(accept(1)).toBe("application/json+canvas-string-ids");
    expect(accept(2)).toBe("application/json");
    await expect(api.user()).rejects.toThrow("did not return a user identity");
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
  it("retries a 403 that is Canvas throttling, and only that kind", async () => {
    const limited = () => new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403 });
    const recovered = setup([limited(), json({ id: 7 })]);
    expect(await recovered.api.user()).toBe("7");
    const stuck = setup([limited(), limited(), limited()]);
    await expect(stuck.api.user()).rejects.toMatchObject({ status: 403, throttled: true });
    expect(stuck.fetcher).toHaveBeenCalledTimes(3);
    const refused = setup([new Response("user not authorized", { status: 403 }), json({ id: 7 })]);
    await expect(refused.api.user()).rejects.toMatchObject({ status: 403, throttled: false });
    expect(refused.fetcher).toHaveBeenCalledTimes(1);
    // Notion has no such convention, so its 403 is always a refusal.
    const notion = setup([limited(), json({})]);
    await expect(notion.api.markDone("page-123")).rejects.toMatchObject({ throttled: false });
  });
  it("retries a body that stopped arriving instead of calling it a non-JSON answer", async () => {
    const cut = json({ id: 7 });
    vi.spyOn(cut, "text").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const { api, fetcher } = setup([cut, json({ id: 7 })]);
    expect(await api.user()).toBe("7");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("accepts the destination whatever the case of the configured data-source ID", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(page()));
    const api = new Api(
      { ...config, dataSourceId: "ABCDEF12-1234-1234-1234-123456789ABC" },
      { fetcher, pause: async () => undefined },
    );
    const raw = page();
    raw.parent.data_source_id = "abcdef12-1234-1234-1234-123456789abc";
    fetcher.mockResolvedValueOnce(json(raw));
    expect((await api.target("page-123"))?.assignmentId).toBe("123");
  });
  it("does not wait out a retry delay once the scan has been cancelled", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      // Pause lands while the request is out; the answer then asks for a one-second retry wait.
      controller.abort();
      return new Response("", { status: 503 });
    });
    const api = new Api(config, { fetcher, signal: controller.signal });
    const started = Date.now();
    await expect(api.user()).rejects.not.toBeInstanceOf(ApiError);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends nothing once the scan has been cancelled", async () => {
    const controller = new AbortController();
    const { api, fetcher } = setup([json({ id: 7 })], controller.signal);
    controller.abort();
    await expect(api.user()).rejects.not.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
