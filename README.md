# Canvas ICS → Notion Sync

A strict TypeScript/Node.js service that imports Canvas assignments from a private Canvas ICS calendar feed into Notion. It is designed for institutions that do not permit students to create Canvas API tokens. It runs every four hours in GitHub Actions and also supports manual validation, dry-run, and live-sync runs.

The sync never uses Canvas OAuth, API tokens, scraping, or browser automation. Completion state belongs entirely to Notion.

## ICS limitations

An ICS feed is narrower than the Canvas API:

- It has no submission state, grades, points, availability windows, or authenticated assignment metadata.
- It cannot tell whether an assignment is complete or submitted.
- It can import only assignments present in Canvas's current calendar-feed window.
- Real institutions can vary slightly in their Canvas UID, description, and course-label formats. The classifier is deliberately conservative; inspect the dry-run warnings after the first real feed is available.

Personal Status, Priority, Notes, Override Due Date, and an assignment's manually edited Assignment Type are never overwritten.

## How it works

1. Configuration is validated and all three Notion data-source schemas are checked without changing them.
2. The ICS document is fetched over HTTPS and parsed with `node-ical`, including folded lines, escaping, UTC, TZID, all-day dates, and daylight-saving transitions.
3. Only events with strong Canvas-assignment evidence are normalized. Ordinary calendar events are skipped.
4. Existing Canvas ICS assignments and courses are read from Notion, then the complete reconciliation plan is built before writes begin.
5. Courses and active assignments are written conservatively. Only after all active writes succeed can guarded removal markers be applied.
6. Live runs write a detailed Canvas Sync Log page. Dry-run and validate modes make no data changes.

The implementation uses an `AssignmentProvider` whose `fetchAssignments()` method returns one `AssignmentFeed` containing active assignments, cancelled assignments, and structured diagnostics. `CanvasIcsProvider` is the initial provider; a future authenticated provider can return the same normalized feed without mutable side channels or reconciliation changes.

## Requirements

- Node.js 24 LTS
- A private Canvas ICS calendar-feed URL
- A Notion internal integration with read, insert, and update content capabilities
- Existing Assignments and Courses data sources, plus a manually created Canvas Sync Log data source
- A GitHub repository with Actions enabled

The Notion API version is explicitly pinned to `2026-03-11`.

## Notion setup

Follow the exact checklist in [docs/notion-setup.md](docs/notion-setup.md). In summary:

- Prepare the documented Assignments, Courses, and Canvas Sync Log schemas exactly.
- Set and share the default assignment template, then share all three data sources with the integration.
- Configure GitHub secrets and variables before running the required validate, dry-run, and sync deployment sequence.

The application validates names, types, required select/status options, and the Course relation target. It never adds, deletes, renames, or converts schema properties.

## Configuration

Copy `.env.example` to `.env` for local use, but do not commit `.env`. The CLI does not load dotenv automatically; export the variables in your shell or use your preferred local secret runner.

Secrets:

```text
CANVAS_ICS_URL
NOTION_TOKEN
```

Variables:

```text
NOTION_ASSIGNMENTS_DATA_SOURCE_ID
NOTION_COURSES_DATA_SOURCE_ID
NOTION_SYNC_LOG_DATA_SOURCE_ID
NOTION_TIMEZONE
CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS
```

`NOTION_TIMEZONE` defaults to `America/Los_Angeles` in the GitHub workflow. `CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS` defaults to `6` and rejects values below six hours. The known starting IDs are:

```text
Assignments: 118ccb50-6027-4ccb-ba19-c0b6ac292ab7
Courses:     e2c63549-089a-4461-9f19-52cd0626e386
```

All IDs remain configurable. Supply the new Sync Log data-source ID after creating it.

### Course aliases

Aliases are optional. Copy `config/course-aliases.example.json` to `config/course-aliases.json`, edit it, and commit it only when aliases are needed:

```json
{
  "EN 1": "Engineering 1",
  "Intro to EE [EE 10]": "EE 10"
}
```

The left side is the Canvas label; the right side is an existing Notion Course title or Course Code. An absent file means no aliases.

Both optional JSON files are structurally validated. Alias keys and values must be bounded nonempty strings. `config/assignment-type-rules.json`, when present, must be a nonempty list of supported types with nonempty, bounded phrase lists and no normalized duplicate type/phrase pair. Assignment-type patterns are literal phrases, not regular expressions; matcher construction escapes them.

## Local commands

```bash
npm ci
npm run sync -- --mode validate --trigger manual
npm run sync -- --mode dry-run --trigger manual
npm run sync -- --mode sync --trigger manual
```

Add `--disable-removals` to a sync or dry-run command to suppress removal planning. Fatal configuration, feed, schema, or write errors return a nonzero exit code. Validate reports active, cancelled, ordinary ignored, suspicious, malformed, duplicate, and quarantined counts plus removal safety without printing UIDs, titles, descriptions, or feed contents. Ordinary events and deterministically normalized cancellations do not cause warning status; unsafe assignment diagnostics do. `Skipped` now counts assignment reconciliation work withheld for safety, not ordinary events, quarantined diagnostics, and cancellations combined into one number.

Development checks:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm audit
```

Tests use synthetic ICS and in-memory Notion doubles; they require no live credentials.

## GitHub Actions

Add the two secrets, four required variables, and optional health-grace variable under **Settings → Secrets and variables → Actions**. Then open **Actions → Canvas–Notion sync → Run workflow** and run in this order:

1. `validate`
2. `dry-run`
3. `sync`

Scheduled runs execute at minute 17 every four hours. Manual runs can select any mode and disable removal detection. Concurrency prevents overlapping syncs.

The health workflow opens or reuses a durable issue after three consecutive qualifying scheduled failures, after the no-success watchdog expires, or when the sync workflow is disabled. Manual runs do not affect scheduled health. See [docs/health-monitor.md](docs/health-monitor.md) for the authoritative run classification, timing, incident, recovery, and privacy policy.

In GitHub Actions, fatal application failures produce sanitized `::error::` annotations and meaningful suspicious diagnostics produce a sanitized `::warning::`; ordinary ignored calendar events do not produce annotations. The job summary records mode and trigger, applied or proposed assignment and course counts, feed diagnostic counts, Notion request/retry metrics, removal-inference state, and a one-line failure summary without stacks. Summary-file I/O is best-effort: an append failure emits a sanitized warning but cannot change the synchronization result or exit status, and workflow annotations are still attempted. Normal logs retain sanitized diagnostic stacks. CI validates workflow syntax and expressions with pinned actionlint v1.7.12. GitHub-maintained actions are pinned to immutable commits, and npm caching uses `package-lock.json`.

No SMTP or external mail service is used. In GitHub notification settings, enable email or web notifications for failed Actions workflows. Watch this repository for new issues and issue updates, and subscribe to the `Canvas–Notion sync is unhealthy` issue when it is created. GitHub owns notification delivery.

## Reconciliation behavior

The ICS UID is the primary identity. An exact normalized Canvas assignment URL or assignment ID is strong duplicate evidence. Title-and-date lookalikes are considered possible duplicates only when course identity is compatible through Canvas Course ID, the resolved Notion course, or normalized course name/code. Possible duplicates are reported and preserved without merging or rewriting UIDs.

Notion failures are centrally classified as a definite HTTP response, a recognized transport failure, or a definite client error. The transport class is deliberately bounded to safe signals such as standard network codes, aborts, known fetch/undici codes, and nested causes; unknown JavaScript errors are not assumed to be network failures. Reads and deterministic property updates use bounded exponential-backoff retries for retryable responses and transport failures.

A statusless transport failure on a write is ambiguous because Notion may have committed the request before the connection was lost. Page creation and block appends therefore do not blindly retry it. Assignment creation is recovered by Canvas UID, course creation by Canvas Course ID or normalized title/code, and Sync Log creation by workflow-run identity. Managed block appends resume from a verified visible prefix, and deletes are observed before at most one justified follow-up. One matching page is recovered; no match remains an explicit ambiguity, and multiple matches stop the run rather than risk a duplicate.

If multiple source `VEVENT`s have the same UID, every event with that UID is quarantined: none is selected for import or update. The UID still counts as present for removal safety, one redacted warning is recorded, and unrelated events continue normally.

`STATUS:CANCELLED` assignments are never imported as active. A cancelled UID remains present in source diagnostics; when it maps to exactly one existing Notion assignment and removals are enabled, the plan marks that page `Removed from Canvas = true` and `Canvas State = Removed`. User-owned status, priority, assignment type, notes, due-date overrides, and page content are preserved. Ambiguous cancelled matches are preserved instead of guessed.

Ordinary calendar events are expected in Canvas feeds. Confidently non-assignment events increase the ignored-event count without producing warnings or changing a successful run to `Warning`. Assignment-like events that cannot be classified or normalized remain quarantined warnings.

Courses match in this order: Canvas Course ID, exact title, exact code, normalized title/code, configured alias, then create. Ties at one confidence level are reported as ambiguous and skipped. A course with only an ID is named `Canvas Course <course-id>` until renamed. A source with no course ID, name, or code is skipped without creating a shared unknown course, and matching assignment pages remain protected from removal.

When a non-ID match supplies missing Canvas Course ID or Canvas URL metadata, the plan backfills only blank course fields. Existing nonblank values are never overwritten. `Sync Updated At` means the last successfully applied sync-driven course metadata change, so every successful enrichment updates it; unchanged courses do not. Conflicting IDs or URLs block the affected assignment work, produce a redacted warning, and protect existing assignment pages from removal. Course enrichments have separate plan, execution, and count fields from assignment updates, including partial failures.

On creation, Personal Status is `Not started`, Priority is blank, and Assignment Type is inferred using `config/assignment-type-rules.json`. On later runs, those three user-controlled fields are preserved.

### Effective and override due dates

`Canvas Due Date` follows Canvas. `Effective Due Date` is a normal writable date used by Notion Calendar. Before a Canvas date change, the sync compares Effective Due Date to the previous expected value (Override Due Date when present, otherwise the prior Canvas Due Date):

- A different Effective Due Date is captured in Override Due Date.
- An override continues to win over later Canvas changes.
- Moving Effective Due Date back to the current Canvas Due Date clears the override and resumes following Canvas.
- If Canvas previously had no due date, a populated Effective Due Date is captured as the manual override and preserved when Canvas later adds or changes its date.
- Equivalent timestamps compare by instant, and equivalent date-only/timestamp calendar dates do not create false overrides.

An explicit “no due date” override is not supported because an empty writable date cannot be distinguished unambiguously from missing source data.

### Descriptions

Canvas HTML is sanitized, converted to readable Markdown, and stored completely in one toggle named `Canvas Description — managed by sync`. `Canvas Description Hash` stores a versioned deterministic hash of the final managed representation, while the manually created Date property `Canvas Description Verified At` records the last successful body-integrity verification. A matching hash with verification no more than 30 days old avoids every assignment-body read. A missing, stale, or hash-version-mismatched verification schedules a read-only audit during live apply; dry-run reports the due update without reading the body. The audit requires exactly one canonical toggle, no pending replacement toggle, and exact expected child blocks. A valid audit updates only the verification timestamp. An invalid audit reconciles through the temporary pending marker, verifies the final section, and only then writes the hash and timestamp together. New pages follow the same verify-before-metadata rule after template stabilization. Failed verification leaves both values missing or stale for a later repair. All template content and user-owned sections remain untouched; `Raw Description` is only a bounded searchable excerpt and does not signal body initialization.

The Sync Log separates planned changes from successfully applied changes, failed or ambiguous work, and operations that were not attempted. Live create metrics distinguish confirmed normal creates from ambiguous creates later recovered as existing: logical pages added equals `created + recovered` for both courses and assignments. Recovery never increments the confirmed-create counter, and recovered applied operations are labeled accordingly. Dry-run counts remain proposed operations rather than runtime create/recovery metrics. Debug logs, the Sync Log body, and the GitHub job summary distinguish description audits, audit-only passes, repairs, managed-section replacements, and avoided body reads alongside the existing non-sensitive request/retry, recovery, course, and assignment-page metrics.

### Removal safety

Assignments are never deleted. A safe scheduled run records a first in-window absence in `Canvas Missing Since` and `Canvas Missing Count` without marking the assignment removed. Later safe scheduled runs advance the count; removal requires at least two safe scheduled absences, a count of at least two, and the configured minimum interval since the first observation. A second run before that interval only advances evidence. Manual live runs report candidates but never advance the count. Dry-run follows its declared trigger and shows proposed transitions without writes.

Absence evidence advances only after a complete, nonempty, nontruncated feed under 1,000 events, an absent raw `VEVENT` UID, an in-window stored due date (approximately 30 days back through 366 days ahead), and all existing duplicate, ambiguity, and removal suppressors. Unsafe feeds leave prior evidence unchanged and report why it was not advanced. A present active UID clears its own evidence and reactivates a removed assignment while preserving status, priority, notes, type, override, and page content. A deterministic `STATUS:CANCELLED` match may remove immediately and clears stale missing evidence because cancellation is stronger than inferred absence.

## Security and troubleshooting

Logs, summaries, issues, and errors redact the exact feed URL, Notion token, bearer tokens, and feed query strings. Raw feeds and full descriptions are never logged or stored as artifacts. Canvas HTML is treated as untrusted input. GitHub workflow permissions are minimal.

Common failures:

- **Schema incompatible:** complete the manual property names, types, relations, and options exactly; the application will not repair them.
- **403/404 from Notion:** share all three databases and the default template with the integration and verify read/insert/update capabilities.
- **Default template validation error:** mark an assignment template as the data source default.
- **Feed parses but assignments are skipped:** inspect the redacted structural warnings in dry-run/Sync Log; a real institutional sample may require another high-confidence classifier rule.
- **Unexpected empty feed:** no removals occur. Check Canvas feed availability and privacy settings.
- **Rate limiting/transient errors:** 429 responses use bounded backoff. Ambiguous 5xx responses are retried only for safe reads and deterministic updates; creates and appends use reconciliation.

CI runs `npm audit`, and Dependabot monitors npm and GitHub Actions dependencies.
