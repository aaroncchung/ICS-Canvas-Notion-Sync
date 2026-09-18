# Notion and GitHub setup checklist

The sync validates this setup but never changes database schemas. Perform every schema operation manually in Notion.

## 1. Create the Notion integration

- Create an internal Notion integration.
- Enable **Read content**, **Insert content**, and **Update content** capabilities.
- Copy its token into the GitHub Actions secret `NOTION_TOKEN`; do not place it in source control.

## 2. Prepare Assignments

In the existing Assignments data source, rename:

- `Due` → `Effective Due Date` (Date)
- `Canvas Key` → `Canvas UID` (Rich text)
- `Sync Updated At` → `Last Synced` (Date)

Add:

- `Canvas Due Date` — Date
- `Override Due Date` — Date
- `Canvas Missing Since` — Date
- `Canvas Missing Count` — Number
- `Imported From` — Select, with option `Canvas ICS`
- `Removed from Canvas` — Checkbox
- `Raw Description` — Rich text
- `Canvas Description Hash` — Rich text
- `Canvas Description Verified At` — Date

Confirm all required properties:

| Property                       | Type      | Required options or target                                                |
| ------------------------------ | --------- | ------------------------------------------------------------------------- |
| Assignment                     | Title     | —                                                                         |
| Course                         | Relation  | The configured Courses data source                                        |
| Effective Due Date             | Date      | —                                                                         |
| Canvas Due Date                | Date      | —                                                                         |
| Override Due Date              | Date      | —                                                                         |
| Canvas Missing Since           | Date      | —                                                                         |
| Canvas Missing Count           | Number    | —                                                                         |
| Personal Status                | Status    | `Not started`, `In progress`, `Done`                                      |
| Priority                       | Select    | User-managed options                                                      |
| Assignment Type                | Select    | `Homework`, `Lab`, `Quiz`, `Exam`, `Paper`, `Project`, `Reading`, `Other` |
| Canvas URL                     | URL       | —                                                                         |
| Canvas UID                     | Rich text | —                                                                         |
| Canvas State                   | Select    | `Active`, `Removed`                                                       |
| Imported From                  | Select    | `Canvas ICS`                                                              |
| Last Synced                    | Date      | —                                                                         |
| Removed from Canvas            | Checkbox  | —                                                                         |
| Raw Description                | Rich text | —                                                                         |
| Canvas Description Hash        | Rich text | —                                                                         |
| Canvas Description Verified At | Date      | —                                                                         |
| Notes                          | Rich text | —                                                                         |

Leave older API-oriented properties in place. The ICS sync ignores `Canvas Assignment ID`, `Canvas Course ID`, `Canvas Submitted`, `Canvas Updated At`, `Available From`, `Available Until`, `Points Possible`, `Submission Types`, and `Submitted At`.

For an existing installation, manually add the two missing-evidence properties and `Canvas Description Verified At` with the exact names and types above before upgrading. Leave them blank on existing assignments. The first qualifying scheduled absence initializes missing evidence, and the next live sync audits each matching-hash description whose verification date is blank. The application validates these properties but never creates, renames, converts, or backfills schema fields automatically.

## 3. Check Courses

Confirm these existing properties:

| Property         | Type      |
| ---------------- | --------- |
| Course           | Title     |
| Course Code      | Rich text |
| Canvas Course ID | Rich text |
| Canvas URL       | URL       |
| Active           | Checkbox  |
| Sync Updated At  | Date      |
| Assignments      | Relation  |

The sync does not overwrite Term, Instructor, Notes, Drive Folder, Color, or other user-maintained fields.

## 4. Configure the assignment template

- Keep user-owned sections such as Plan, Notes, and Submission check in the existing assignment template.
- Set that template as the Assignments data source's **default** template.
- Share the template with the integration if it is not inherited automatically from the database connection.

The sync applies the default through Notion's template API, waits for asynchronous template content, and then reconciles its own managed Canvas description toggle. It writes `Canvas Description Hash` and `Canvas Description Verified At` together only after that managed body is verified. Hash changes and blank or invalid verification dates trigger immediate auditing. Matching hashes with valid dates are eligible after 30 calendar days and are distributed across 30 stable slots derived from the Canvas UID. The slot calendar and age use `NOTION_TIMEZONE`, and a 60-calendar-day maximum forces an audit even when the current run is outside the assignment's slot. Thus the first live sync at or after 60 days cannot defer the audit. Dry-run reports audits due and deferred without reading page bodies. The schedule requires no additional Notion properties.

The managed toggle holds native Notion blocks (headings, lists, quotes, code, styled paragraphs). When a release changes that rendering, the hash version changes with it and every existing page is audited once on the next live run: matching bodies get only new metadata, differing bodies are rewritten through the pending marker before their metadata is written. The dry-run report lists the affected pages as `Description format upgrades`.

## 5. Create Canvas Sync Log

Create a database named `Canvas Sync Log` with exactly:

| Property           | Type      | Options                                   |
| ------------------ | --------- | ----------------------------------------- |
| Run                | Title     | —                                         |
| Started At         | Date      | —                                         |
| Finished At        | Date      | —                                         |
| Status             | Select    | `Success`, `Warning`, `Failed`, `Dry Run` |
| Trigger            | Select    | `Scheduled`, `Manual`                     |
| Mode               | Select    | `Sync`, `Dry Run`, `Validate`             |
| Feed Items         | Number    | —                                         |
| Assignments Parsed | Number    | —                                         |
| Created            | Number    | —                                         |
| Updated            | Number    | —                                         |
| Removed            | Number    | —                                         |
| Unchanged          | Number    | —                                         |
| Skipped            | Number    | —                                         |
| Warning Count      | Number    | —                                         |
| Error Summary      | Rich text | —                                         |
| Workflow URL       | URL       | —                                         |
| Commit SHA         | Rich text | —                                         |

Copy its data-source ID for GitHub configuration.

## 6. Share databases

Use each database's **Connections** menu to share with the integration:

- Assignments
- Courses
- Canvas Sync Log

Confirm the Course property in Assignments relates to the exact Courses data source configured in GitHub.

## 7. Configure GitHub Actions

Under **Settings → Secrets and variables → Actions**, add secrets:

- `CANVAS_ICS_URL` — the complete private HTTPS Canvas feed URL
- `NOTION_TOKEN` — the internal integration token

Add variables:

- `NOTION_ASSIGNMENTS_DATA_SOURCE_ID` (known starting value `118ccb50-6027-4ccb-ba19-c0b6ac292ab7`)
- `NOTION_COURSES_DATA_SOURCE_ID` (known starting value `e2c63549-089a-4461-9f19-52cd0626e386`)
- `NOTION_SYNC_LOG_DATA_SOURCE_ID` (the ID created above)
- `NOTION_TIMEZONE` (recommended `America/Los_Angeles`)
- `CANVAS_MISSING_EVIDENCE_MINIMUM_HOURS` (optional; defaults to `6`, minimum `6`)
- `HEALTH_ACTIVATION_GRACE_HOURS` (optional; defaults to `14` hours)

Do not put secret values in variables, workflow inputs, issue text, or repository files.

## 8. First deployment

From **Actions → Canvas–Notion sync → Run workflow**:

1. Run `validate`. Resolve every configuration, permission, feed, and schema error.
2. Run `dry-run`. Review proposed counts and ambiguity/duplicate/skipped warnings; it writes nothing.
3. Run `sync`, optionally with removals disabled for the first live run.
4. Confirm the new Sync Log page and a sample assignment's template, managed description, course relation, and due dates.
5. Enable GitHub notifications for failed workflows, new repository issues, and updates to the `sync-failure` issue.

Scheduled syncs then follow the times configured in `.github/workflows/sync.yml`. The health workflow creates the `sync-failure` label automatically when first needed. Notification delivery remains a GitHub setting, not application email; see [health-monitor.md](health-monitor.md) for the complete scheduled-health and recovery policy.

Validate and GitHub summaries separate ordinary ignored events, suspicious events, malformed events, duplicate UIDs, cancelled assignments, and quarantined UID counts. Sync results also separate newly observed missing candidates, evidence advanced, evidence cleared, and assignments actually marked removed. Manual live runs observe but do not advance missing evidence; scheduled live runs persist qualifying transitions; dry-run proposes the transitions for its selected trigger without writing. Quarantined values are never displayed. Course metadata enrichment is proposed in dry-run and fills only blank Canvas Course ID and Canvas URL fields. Each successful enrichment sets `Sync Updated At` to the last sync-driven course metadata change; unchanged courses retain their timestamp. A conflicting nonblank ID or URL blocks the affected assignment until corrected.
