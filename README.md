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

The implementation uses the `AssignmentProvider` interface. `CanvasIcsProvider` is the initial provider; a future authenticated provider can return the same `ExternalAssignment` model without changing reconciliation.

## Requirements

- Node.js 24 LTS
- A private Canvas ICS calendar-feed URL
- A Notion internal integration with read, insert, and update content capabilities
- Existing Assignments and Courses data sources, plus a manually created Canvas Sync Log data source
- A GitHub repository with Actions enabled

The Notion API version is explicitly pinned to `2026-03-11`.

## Notion setup

Follow the exact checklist in [docs/notion-setup.md](docs/notion-setup.md). In summary:

- Rename `Due` → `Effective Due Date`, `Canvas Key` → `Canvas UID`, and `Sync Updated At` → `Last Synced` in Assignments.
- Add `Canvas Due Date`, `Override Due Date`, `Imported From`, `Removed from Canvas`, and `Raw Description`.
- Create the Canvas Sync Log data source with the documented fields and options.
- Share Assignments, Courses, the default assignment template, and Canvas Sync Log with the integration.
- Make the assignment template the data source's default. New pages use Notion's current default-template API, which applies the template asynchronously; the sync waits before adding its managed description.

The application validates names, types, required select/status options, and the Course relation target. It never adds, deletes, renames, or converts schema properties. Older Canvas-API-oriented fields are ignored.

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
```

`NOTION_TIMEZONE` defaults to `America/Los_Angeles` in the GitHub workflow. The known starting IDs are:

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

## Local commands

```bash
npm ci
npm run sync -- --mode validate --trigger manual
npm run sync -- --mode dry-run --trigger manual
npm run sync -- --mode sync --trigger manual
```

Add `--disable-removals` to a sync or dry-run command to suppress removal planning. Fatal configuration, feed, schema, or write errors return a nonzero exit code. Feed titles and descriptions are not printed during validate mode.

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

Add the two secrets and four variables under **Settings → Secrets and variables → Actions**. Then open **Actions → Canvas–Notion sync → Run workflow** and run in this order:

1. `validate`
2. `dry-run`
3. `sync`

Scheduled runs execute at minute 17 every four hours. Manual runs can select any mode and disable removal detection. Concurrency prevents overlapping syncs.

The health workflow checks only scheduled `sync.yml` runs. It opens or updates one `sync-failure` issue after three consecutive scheduled failures or twelve hours without a successful scheduled run. A later successful scheduled run receives a recovery comment and closes the issue. The issue includes only workflow metadata and links, never feed content or secrets.

### GitHub email notifications

No SMTP or external mail service is used. In GitHub notification settings, enable email or web notifications for failed Actions workflows. Watch this repository for new issues and issue updates, and subscribe to the `Canvas–Notion sync is unhealthy` issue when it is created.

## Reconciliation behavior

The ICS UID is the primary identity. Canvas URL, assignment ID, course ID, normalized title, and due date are only duplicate evidence. Duplicate UIDs or strong lookalikes are reported and preserved without merging.

Courses match in this order: Canvas Course ID, exact title, exact code, normalized title/code, configured alias, then create. Ties at one confidence level are reported as ambiguous and skipped. A course with only an ID is named `Canvas Course <course-id>` until renamed.

On creation, Personal Status is `Not started`, Priority is blank, and Assignment Type is inferred using `config/assignment-type-rules.json`. On later runs, those three user-controlled fields are preserved.

### Effective and override due dates

`Canvas Due Date` follows Canvas. `Effective Due Date` is a normal writable date used by Notion Calendar. Before a Canvas date change, the sync compares Effective Due Date to the previous expected value (Override Due Date when present, otherwise the prior Canvas Due Date):

- A different Effective Due Date is captured in Override Due Date.
- An override continues to win over later Canvas changes.
- Moving Effective Due Date back to the current Canvas Due Date clears the override and resumes following Canvas.
- Equivalent timezone serializations compare by instant, avoiding false overrides.

An explicit “no due date” override is not supported because an empty writable date cannot be distinguished unambiguously from missing source data.

### Descriptions

Canvas HTML is sanitized, converted to readable Markdown, and stored completely in one toggle named `Canvas Description — managed by sync`. Only that toggle and its children are replaced. All template content and user-owned sections such as Plan, Notes, and Submission check remain untouched. `Raw Description` stores a bounded searchable plain-text excerpt.

### Removal safety

Assignments are never deleted. An absent imported assignment can be marked `Removed from Canvas = true` and `Canvas State = Removed` only after a complete, nonempty, nontruncated feed under 1,000 events, successful active writes, an absent UID, an in-window stored due date (approximately 30 days back through 366 days ahead), and enabled removal detection. Empty or suspicious feeds preserve every page. A reappearing UID is reactivated without changing status, priority, notes, type, override, or page content.

## Security and troubleshooting

Logs, summaries, issues, and errors redact the exact feed URL, Notion token, bearer tokens, and feed query strings. Raw feeds and full descriptions are never logged or stored as artifacts. Canvas HTML is treated as untrusted input. GitHub workflow permissions are minimal.

Common failures:

- **Schema incompatible:** complete the manual property names, types, relations, and options exactly; the application will not repair them.
- **403/404 from Notion:** share all three databases and the default template with the integration and verify read/insert/update capabilities.
- **Default template validation error:** mark an assignment template as the data source default.
- **Feed parses but assignments are skipped:** inspect the redacted structural warnings in dry-run/Sync Log; a real institutional sample may require another high-confidence classifier rule.
- **Unexpected empty feed:** no removals occur. Check Canvas feed availability and privacy settings.
- **Rate limiting/transient errors:** 429 and 5xx responses are retried with bounded exponential backoff and jitter.

`npm audit` reports zero known vulnerabilities for the committed lockfile. Dependabot monitors npm and GitHub Actions dependencies.
