# Notion and GitHub setup checklist

The sync validates this setup but never changes database schemas. Perform every schema operation manually in Notion.

## 1. Create the Notion integration

- Create an internal Notion integration.
- Enable **Read content**, **Insert content**, and **Update content** capabilities.
- Copy its token into the GitHub Actions secret `NOTION_TOKEN`; do not place it in source control.

## 2. Prepare Assignments

The Assignments data source needs every property below, with these exact names and types:

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

Any other property in the data source is ignored and left untouched.

`Canvas Missing Since`, `Canvas Missing Count`, and `Canvas Description Verified At` may be blank on any page. The first qualifying scheduled absence initializes missing evidence, and a live sync audits every description whose verification date is blank. The application validates these properties but never creates, renames, converts, or backfills schema fields automatically.

## 3. Check Courses

The Courses data source needs these properties:

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

- Put user-owned sections such as Plan, Notes, and Submission check in an assignment template.
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

Copy its data-source ID (database menu → **Manage data sources** → **Copy data source ID**) for GitHub configuration.

## 6. Share databases

Use each database's **Connections** menu to share with the integration:

- Assignments
- Courses
- Canvas Sync Log

Confirm the Course property in Assignments relates to the exact Courses data source configured in GitHub.

## 7. Configure GitHub Actions

In the repository that runs the sync (the private runner described in [Scheduled runs](#9-scheduled-runs)), under **Settings → Secrets and variables → Actions**, add secrets:

- `CANVAS_ICS_URL` — the complete private HTTPS Canvas feed URL
- `NOTION_TOKEN` — the internal integration token

Add variables:

- `NOTION_ASSIGNMENTS_DATA_SOURCE_ID`
- `NOTION_COURSES_DATA_SOURCE_ID`
- `NOTION_SYNC_LOG_DATA_SOURCE_ID`
- `NOTION_TIMEZONE` (optional; an IANA zone, defaults to `America/Los_Angeles`)
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

Scheduled syncs then follow the times configured in the runner's `.github/workflows/sync.yml` (see [Scheduled runs](#9-scheduled-runs)). The health workflow creates the `sync-failure` label automatically when first needed. Notification delivery remains a GitHub setting, not application email; see [health-monitor.md](health-monitor.md) for the complete scheduled-health and recovery policy.

Validate and GitHub summaries separate ordinary ignored events, suspicious events, malformed events, duplicate UIDs, cancelled assignments, and quarantined UID counts. Sync results also separate newly observed missing candidates, evidence advanced, evidence cleared, and assignments actually marked removed. Manual live runs observe but do not advance missing evidence; scheduled live runs persist qualifying transitions; dry-run proposes the transitions for its selected trigger without writing. Quarantined values are never displayed. Course metadata enrichment is proposed in dry-run and fills only blank Canvas Course ID and Canvas URL fields. Each successful enrichment sets `Sync Updated At` to the last sync-driven course metadata change; unchanged courses retain their timestamp. A conflicting nonblank ID or URL blocks the affected assignment until corrected.

## 9. Scheduled runs

The workflows in this repository run only when started by hand. GitHub disables scheduled workflows in a public repository after 60 days without a commit, and it would disable the health workflow at the same moment, so nothing would report the outage. Private repositories are exempt, so the schedules live in a private runner repository:

1. Create a private repository and copy `.github/workflows/sync.yml` and `.github/workflows/health-check.yml` into it.
2. Add the schedules. The minutes avoid `:00` and `:30`, when GitHub is busiest.

   ```yaml
   # sync.yml
   on:
     schedule:
       - cron: "37 1,8,12,15,17 * * *"
         timezone: "America/New_York"
       - cron: "13 14 * * *"
         timezone: "America/New_York"
     workflow_dispatch: # unchanged

   # health-check.yml
   on:
     schedule:
       - cron: "47 */4 * * *"
     workflow_dispatch:
   ```

3. Point every `actions/checkout` step at this repository:

   ```yaml
   - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
     with:
       repository: <owner>/ICS-Canvas-Notion-Sync
       ref: main
       persist-credentials: false
   ```

4. Add the secrets and variables from step 7 to the runner, then run the step 8 sequence there.

Each run uses this repository's `main` as it is at that moment, so a merge here takes effect on the next scheduled run. The health workflow reads the runner's own `sync.yml` runs and keeps its issue in the runner. When a workflow here changes (a new variable, input, or step), make the same change in the runner. If your copy of this repository is private, you can instead add the schedules to its own workflows.
