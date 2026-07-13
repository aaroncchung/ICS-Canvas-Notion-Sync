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
- `Imported From` — Select, with option `Canvas ICS`
- `Removed from Canvas` — Checkbox
- `Raw Description` — Rich text

Confirm all required properties:

| Property            | Type      | Required options or target                                                |
| ------------------- | --------- | ------------------------------------------------------------------------- |
| Assignment          | Title     | —                                                                         |
| Course              | Relation  | The configured Courses data source                                        |
| Effective Due Date  | Date      | —                                                                         |
| Canvas Due Date     | Date      | —                                                                         |
| Override Due Date   | Date      | —                                                                         |
| Personal Status     | Status    | `Not started`, `In progress`, `Done`                                      |
| Priority            | Select    | User-managed options                                                      |
| Assignment Type     | Select    | `Homework`, `Lab`, `Quiz`, `Exam`, `Paper`, `Project`, `Reading`, `Other` |
| Canvas URL          | URL       | —                                                                         |
| Canvas UID          | Rich text | —                                                                         |
| Canvas State        | Select    | `Active`, `Removed`                                                       |
| Imported From       | Select    | `Canvas ICS`                                                              |
| Last Synced         | Date      | —                                                                         |
| Removed from Canvas | Checkbox  | —                                                                         |
| Raw Description     | Rich text | —                                                                         |
| Notes               | Rich text | —                                                                         |

Leave older API-oriented properties in place. The ICS sync ignores `Canvas Assignment ID`, `Canvas Course ID`, `Canvas Submitted`, `Canvas Updated At`, `Available From`, `Available Until`, `Points Possible`, `Submission Types`, and `Submitted At`.

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

The sync applies the default through Notion's template API, waits for asynchronous template content, and then appends its own managed Canvas description toggle.

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

Do not put secret values in variables, workflow inputs, issue text, or repository files.

## 8. First deployment

From **Actions → Canvas–Notion sync → Run workflow**:

1. Run `validate`. Resolve every configuration, permission, feed, and schema error.
2. Run `dry-run`. Review proposed counts and ambiguity/duplicate/skipped warnings; it writes nothing.
3. Run `sync`, optionally with removals disabled for the first live run.
4. Confirm the new Sync Log page and a sample assignment's template, managed description, course relation, and due dates.
5. Enable GitHub notifications for failed workflows, new repository issues, and updates to the `sync-failure` issue.

Scheduled syncs then run every four hours. The health workflow creates the `sync-failure` label automatically when first needed.
