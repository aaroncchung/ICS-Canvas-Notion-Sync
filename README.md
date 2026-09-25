# Canvas ICS → Notion Sync

A strict TypeScript/Node.js service that imports Canvas assignments from a private Canvas ICS calendar feed into Notion. It is designed for institutions that do not permit students to create Canvas API tokens. It runs on a schedule in GitHub Actions, from a private runner repository, and also supports manual validation, dry-run, and live-sync runs.

The scheduled ICS sync never uses Canvas OAuth, API tokens, scraping, or browser automation. It preserves completion state in Notion. The optional [Chrome companion extension](docs/chrome-extension.md) uses your signed-in Canvas session to mark submitted, graded, or excused assignments Done while respecting work you manually reopen.

## ICS limitations

An ICS feed is narrower than the Canvas API:

- It has no submission state, grades, points, availability windows, or authenticated assignment metadata.
- It cannot tell whether an assignment is complete or submitted.
- It can import only assignments present in Canvas's current calendar-feed window.
- Real institutions can vary slightly in their Canvas UID, description, and course-label formats. The classifier is deliberately conservative; inspect the dry-run warnings whenever the sync is pointed at a new institution's feed.

The ICS importer never overwrites Personal Status, Priority, Notes, Override Due Date, or an assignment's manually edited Assignment Type. The optional extension can set only Personal Status to Done.

## How it works

1. Configuration is validated and all three Notion data-source schemas are checked without changing them.
2. The ICS document is fetched over HTTPS and parsed with `node-ical`, including folded lines, escaping, UTC, TZID, all-day dates, and daylight-saving transitions.
3. Only events with strong Canvas-assignment evidence are normalized. Ordinary calendar events are skipped.
4. Existing Canvas ICS assignments and courses are read from Notion, then the complete reconciliation plan is built before writes begin.
5. Courses and active assignments are written conservatively. Only after all active writes succeed can guarded removal markers be applied.
6. Live runs write a detailed Canvas Sync Log page. Dry-run and validate modes make no data changes.

The implementation uses an `AssignmentProvider` whose `fetchAssignments()` method returns one `AssignmentFeed` containing active assignments, cancelled assignments, and structured diagnostics. `CanvasIcsProvider` is the only provider; any other provider can return the same normalized feed without mutable side channels or reconciliation changes.

The synchronization core collects course evidence first, finalizes each assignment decision once, and then plans guarded removal evidence. Execution and Sync Log reporting share one ordered command sequence. See [the core architecture](docs/sync-core.md) for its boundaries and recovery invariants.

## Requirements

- Node.js 24 LTS
- A private Canvas ICS calendar-feed URL
- A Notion internal integration with read, insert, and update content capabilities
- Assignments, Courses, and Canvas Sync Log data sources in Notion, created manually
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

`NOTION_TIMEZONE` defaults to `America/Los_Angeles` in the GitHub workflow. `CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS` defaults to `6` and rejects values below six hours. The three data-source IDs have no defaults; copy each one from its database's **Manage data sources** menu in Notion.

### Course aliases

Aliases are optional. Copy `config/course-aliases.example.json` to `config/course-aliases.json`, edit it, and commit it only when aliases are needed:

```json
{
  "EN 1": "Engineering 1",
  "Intro to EE [EE 10]": "EE 10"
}
```

The left side is the Canvas label; the right side is an existing Notion Course title or Course Code. An absent file means no aliases.

The Canvas label in square brackets is always the course name. A Course Code is extracted from it only when it contains an uppercase department prefix of at least two letters followed by a course number of up to four digits and an optional section letter, such as `EE 10`, `CS-61A`, `BIO101`, or `MATH 2B`. Matching is case-sensitive, and uppercase term, structure, and work words such as `FALL 2026`, `FA26`, `SPR26`, `SUM2026`, `WEEK 2`, or `HW 3` are skipped, so `[Fall 2026 Biology]` yields no code and `[FA26 CS 101]` yields `CS 101`. A term tag not on that list is still skipped when it is written as one token of letters and a two- or four-digit year and another code follows it, so `[FS26 CS 101]` yields `CS 101` while `[ENGL1010]` keeps `ENGL1010`. Running the sync workflow manually with the `compare-course-codes` mode reruns the legacy and current extraction against the real feed and Notion snapshot without writing anything and reports whether any course destination would change. Alias source keys must remain unique after the same Unicode, punctuation, whitespace, and casing normalization used for course matching; duplicate normalized sources are rejected even when their targets are equivalent, so configuration intent stays explicit.

Both optional JSON files are structurally validated. Alias keys and values must be bounded nonempty strings. `config/assignment-type-rules.json`, when present, must be a nonempty list of supported types with nonempty, bounded phrase lists and no normalized duplicate type/phrase pair. Assignment-type patterns are literal phrases, not regular expressions; matcher construction escapes them.

## Local commands

```bash
npm ci
npm run sync -- --mode validate --trigger manual
npm run sync -- --mode dry-run --trigger manual
npm run sync -- --mode sync --trigger manual
```

Add `--disable-removals` to a sync or dry-run command to suppress removal planning. Fatal configuration, feed, schema, or write errors return a nonzero exit code. Validate reports active, cancelled, ordinary ignored, suspicious, malformed, duplicate, and quarantined counts plus removal safety without printing UIDs, titles, descriptions, or feed contents. Ordinary events and deterministically normalized cancellations do not cause warning status; unsafe assignment diagnostics do. `Skipped` counts only assignment reconciliation work withheld for safety; ordinary events, quarantined diagnostics, and cancellations each have their own count.

Development checks:

```bash
npm run lint
npm run format:check
npm run check:types-and-build
npm run test:unit
npm run test:integration
npm audit
```

Node 24 runs the TypeScript sources directly (`node src/cli.ts`, `node scripts/check-health.ts`), so no build step is needed to run the application. To keep that working, `tsconfig.json` enables `erasableSyntaxOnly` and `verbatimModuleSyntax`, and relative imports use `.ts` specifiers; `npm run build` still emits plain JavaScript to `dist/` with rewritten import extensions.

The type-check and build scripts use the native TypeScript 7 compiler. Type-aware ESLint uses TypeScript 6 as its compiler API until `typescript-eslint` supports the native compiler.

Tests use synthetic ICS and in-memory Notion doubles; they require no live credentials.

## GitHub Actions

The workflows in this repository run only when started by hand. GitHub disables scheduled workflows in a public repository after 60 days without a commit, so a private runner repository holds the schedules, the secrets, and copies of `sync.yml` and `health-check.yml` that check out and run this repository's `main`. See [Scheduled runs](docs/notion-setup.md#9-scheduled-runs) for the setup.

In the repository that runs the sync, add the two secrets, the three required data-source ID variables, and any optional variables under **Settings → Secrets and variables → Actions**. Then open **Actions → Canvas–Notion sync → Run workflow** and run in this order:

1. `validate`
2. `dry-run`
3. `sync`

Scheduled runs are requested at 01:37, 08:37, 12:37, 14:13, 15:37, and 17:37 in `America/New_York`. GitHub treats schedules as best effort: in July to September 2026 it ran the sync about four times a day, often hours late, and skipped the remaining slots, so expect roughly four syncs a day at irregular times. Manual runs can select any mode and disable removal detection. Concurrency prevents overlapping syncs.

The health workflow is requested every four hours (in practice about four times a day) and keeps one `Canvas–Notion sync is unhealthy` issue. It opens or reopens that issue after three consecutive scheduled failures, when no scheduled run has succeeded within 24 hours, or when the sync workflow is disabled, and closes it once a newer scheduled run succeeds. Manual runs do not affect scheduled health. See [docs/health-monitor.md](docs/health-monitor.md) for the authoritative run classification, timing, issue lifecycle, and privacy policy.

In GitHub Actions, fatal application failures produce sanitized `::error::` annotations and meaningful suspicious diagnostics produce a sanitized `::warning::`; ordinary ignored calendar events do not produce annotations. The job summary records mode and trigger, applied or proposed assignment and course counts, feed diagnostic counts, Notion request/retry metrics, removal-inference state, and a one-line failure summary without stacks. Summary-file I/O is best-effort: an append failure emits a sanitized warning but cannot change the synchronization result or exit status, and workflow annotations are still attempted. Normal logs retain sanitized diagnostic stacks. CI validates workflow syntax and expressions with pinned actionlint v1.7.12. GitHub-maintained actions are pinned to immutable commits. Scheduled workflows skip the build entirely: the sync job installs only runtime dependencies (cached by `package-lock.json`) and the health job installs nothing.

No SMTP or external mail service is used. In GitHub notification settings, enable email or web notifications for failed Actions workflows. Watch this repository for new issues and issue updates, and subscribe to the `Canvas–Notion sync is unhealthy` issue when it is created. GitHub owns notification delivery.

## Reconciliation behavior

The ICS UID is the primary identity. An exact normalized Canvas assignment URL or assignment ID is strong duplicate evidence. Title-and-date lookalikes are considered possible duplicates only when course identity is compatible through Canvas Course ID, the resolved Notion course, or normalized course name/code. A lookalike is never a possible duplicate when its own UID is still in the feed, or when both sides carry Canvas assignment IDs and those IDs differ, so two same-named assignments due the same day, or an assignment deleted and recreated in Canvas, are both imported. Possible duplicates are reported and preserved without merging or rewriting UIDs.

Notion failures are centrally classified as a definite HTTP response, a recognized transport failure, or a definite client error. The transport class is deliberately bounded to safe signals such as standard network codes, aborts, known fetch/undici codes, and nested causes; unknown JavaScript errors are not assumed to be network failures. Reads and deterministic property updates use bounded exponential-backoff retries for retryable responses and transport failures. A `429 rate_limited` or `529 service_overload` response means Notion rejected the request without processing it, so every operation, including creates and appends, retries it. The wait is the response's `Retry-After` (seconds or an HTTP date), capped at 60 seconds, or the usual backoff when the header is missing, malformed, or a date that has already passed. A request makes at most four attempts, and a `529` that is still failing after the last one is reported as a definite failure, not an ambiguous write.

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

Canvas HTML is sanitized, converted to Markdown, and then rendered as native Notion blocks inside one toggle named `Canvas Description — managed by sync`: headings, bulleted and numbered lists, quotes, code blocks, and paragraphs whose rich text carries bold, italic, inline code, and absolute `http(s)`/`mailto` links. Nothing is cut mid-word: a long run is split into rich-text items at whitespace, and a block that needs more than Notion's 100 items continues in a further block of the same type. The section stays flat so that every managed block is verified in full: nested lists flatten to siblings, tables become one paragraph per row with cells joined by `|` and header rows in bold (block content inside a cell and nested tables fold into that row, and rows with no text are dropped), and links are written in serialized, percent-encoded form while relative or unparseable links keep their text without a link. `Raw Description` holds the visible text of those same blocks. `Canvas Description Hash` stores a versioned deterministic hash of the final managed representation, while the manually created Date property `Canvas Description Verified At` records the last successful body-integrity verification. Hash changes and missing or invalid verification timestamps schedule an immediate body audit. Matching hashes with valid timestamps use a deterministic 30-slot calendar schedule: after 30 calendar days, a SHA-256 slot derived from the stable Canvas UID selects one audit day in the next 30 days. Slot and age calculations use `NOTION_TIMEZONE`; no random run-time values or additional Notion properties are involved. The 60-day maximum-age rule overrides slot deferral, so the first synchronization at or after 60 local calendar days always audits the assignment. Dry-run reports audits due and deferred without reading page bodies.

The audit requires exactly one canonical toggle, no pending replacement toggle, and exact expected child blocks; only the way Notion segments a run of identically styled text into rich-text items is ignored. A replacement that cannot be verified reports the first block and field that differ. A valid audit updates only the verification timestamp. An invalid audit reconciles through the temporary pending marker, verifies the final section, and only then writes the hash and timestamp together. New pages follow the same verify-before-metadata rule after template stabilization. Failed verification leaves both values missing or stale for a later repair. All template content and user-owned sections remain untouched; `Raw Description` is only a bounded searchable excerpt and does not signal body initialization.

#### Format upgrades

The hash version (`canvas-description:v3`) changes whenever the rendered blocks change for the same Canvas input, so every page stored under an older version differs from its current hash and is audited on the next live run. That audit is the ordinary one: a page whose body already matches the new rendering (for example the `No description provided.` placeholder) passes and receives only the new hash and timestamp; any other page is rewritten once through the pending marker, verified, and only then given its metadata. A run that fails midway leaves the old hash in place, so the remaining pages are simply picked up by the next run. The cost is about eight Notion requests for a typical rewritten page (four reads, four writes), three for a page whose body already matches, plus one extra append per hundred blocks of a long description; under Notion's three-requests-per-second budget that is a few seconds per page. Dry-run and live reports count these pages as `Description format upgrades` without reading any body, so a dry run shows the size of the one-time migration before it happens. Upgrading changes only the managed toggle's children; user-owned sections are never touched.

The Sync Log separates planned changes from successfully applied changes, failed or ambiguous work, and operations that were not attempted. Live create metrics distinguish confirmed normal creates from ambiguous creates later recovered as existing: logical pages added equals `created + recovered` for both courses and assignments. Recovery never increments the confirmed-create counter, and recovered applied operations are labeled accordingly. Dry-run counts remain proposed operations rather than runtime create/recovery metrics. Debug logs, the Sync Log body, and the GitHub job summary distinguish description audits, audit-only passes, repairs, managed-section replacements, and avoided description updates alongside the non-sensitive request/retry, recovery, course, and assignment-page metrics.

### Removal safety

Assignments are never deleted. A safe scheduled run records a first in-window absence in `Canvas Missing Since` and `Canvas Missing Count` without marking the assignment removed. Later safe scheduled runs advance the count; removal requires at least two safe scheduled absences, a count of at least two, and the configured minimum interval since the first observation. A second run before that interval only advances evidence. Manual live runs report candidates but never advance the count. Dry-run follows its declared trigger and shows proposed transitions without writes.

Absence evidence advances only after a complete, nonempty, nontruncated feed under 1,000 events, an absent raw `VEVENT` UID, an in-window stored due date (approximately 30 days back through 366 days ahead), and no active duplicate, ambiguity, or removal suppressor. Unsafe feeds leave prior evidence unchanged and report why it was not advanced. A present active UID clears its own evidence and reactivates a removed assignment while preserving status, priority, notes, type, override, and page content. A UID that is present but quarantined (malformed, suspicious, or duplicated) also clears the evidence of its page that is not marked removed, even when the feed is otherwise unsafe or removals are disabled, so an absence after that sighting starts a new count instead of completing the old one; it does not reactivate a removed page. A deterministic `STATUS:CANCELLED` match may remove immediately and clears stale missing evidence because cancellation is stronger than inferred absence.

## Security and troubleshooting

Logs, summaries, issues, and errors redact the exact feed URL, Notion token, bearer tokens, and feed query strings. Raw feeds and full descriptions are never logged or stored as artifacts. Canvas HTML is treated as untrusted input. GitHub workflow permissions are minimal.

Common failures:

- **Schema incompatible:** complete the manual property names, types, relations, and options exactly; the application will not repair them.
- **403/404 from Notion:** share all three databases and the default template with the integration and verify read/insert/update capabilities.
- **Default template validation error:** mark an assignment template as the data source default.
- **Feed parses but assignments are skipped:** inspect the redacted structural warnings in dry-run/Sync Log; a real institutional sample may require another high-confidence classifier rule.
- **Unexpected empty feed:** no removals occur. Check Canvas feed availability and privacy settings.
- **Rate limiting/transient errors:** 429 and 529 responses are retried for every operation after the `Retry-After` delay (capped at 60 seconds), or bounded backoff when there is none. The Sync Log and job summary report how many retries these caused and how long they waited, summed across requests, so concurrent waits add up. Ambiguous 5xx responses are retried only for safe reads and deterministic updates; creates and appends use reconciliation.

CI fails on advisories in runtime dependencies (`npm audit --omit=dev`) and reports advisories in development tools without failing (`npm audit`). Dependabot monitors npm and GitHub Actions dependencies.
