# Chrome companion

This personal, unpacked extension marks existing Notion assignments **Done** using your logged-in Canvas session. The scheduled ICS importer continues to create assignments and maintain their metadata. No Notion schema changes or Canvas API token are needed.

## Install and connect

1. Run `npm ci` and `npm run build:extension` (Node 24).
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `dist/extension` directory.
3. Sign in to Canvas in that Chrome profile. Open the extension's **Settings**.
4. Enter the Canvas HTTPS origin from your browser (without a path), your Assignments **data-source ID**, and a Notion integration token with read/update access to that database. You can use the existing integration; a dedicated integration shared only with Assignments reduces its access.
5. Click **Verify and save**, granting access to that Canvas host. Verification performs read-only Canvas session and Notion schema checks. A blank token retains the saved token.
6. Run **Preview** and review the matching assignments and reasons. Then choose **Enable sync**, followed by **Sync now** for your initial sync.

Automatic checks run on visits, navigation, tab activation, and window focus, at most once every five minutes. While Canvas is the active tab of the focused window, an alarm checks whether another scan is due. Once started, a scan continues across navigation or closing the Canvas tab. **Pause** cancels remaining scan work; changes already sent cannot be undone. **Sync now** bypasses the cooldown but respects Pause and completion history.

After updating the source, rebuild and click **Reload** on the extension in Chrome. Keep the same unpacked directory to preserve its local history.

## Matching and completion

Assignment IDs come first from Canvas UID (such as `event-assignment-123`), falling back to assignment URLs. This supports imported pages with blank URLs. Conflicting identities, duplicates, and removed pages are skipped. Active courses are read first; completed enrollments are read only while a tracked assignment is still unaccounted for. Assignments in courses Canvas will not let you read are reported as unchecked. The configured database must belong to this one Canvas instance/account. Hostname aliases in Notion links do not affect identity and are never used as request destinations.

The extension sets only **Personal Status** to **Done** for actual submissions, excused work, or graded work not marked missing. A zero grade counts unless Canvas marks it missing. Redo requests are deferred. No grades, submissions, descriptions, or dates are written into Notion.

Completion is acknowledged locally per page and submission attempt. Later grading or excusal of the same attempt does not override a manual reopening; a new submission attempt may set Done again. Existing Done pages are acknowledged without writing. Clearing extension storage or removing/reinstalling the extension loses this history, so review Preview afterward. The first scan cannot know about manual reopenings made before installation.

## Recovery and privacy

A scan runs in one pass and keeps its progress only in memory. If Chrome stops the worker midway, the popup shows that scan as interrupted and the next trigger simply scans again; nothing needs repair. This is safe because each page is reread immediately before it is written, and handled submissions are saved as soon as each page is dealt with. Temporary failures are retried a few times within the scan. A write whose outcome is unknown is rechecked by the next scan: a page that became Done is acknowledged without writing, and one that did not is written again. Preview never writes or consumes completion acknowledgements.

An expired Canvas login, a network outage, or a service error ends that scan with a message and leaves automatic sync on; it tries again after a minute once Canvas is visited or visible. Only a changed Canvas account or a Notion schema that no longer fits turns automatic sync off.

Changing Canvas accounts turns syncing off; sign into the intended account, verify Settings again, then run Preview and enable sync. Changing the configured instance, account, or Notion data source starts fresh local history. Session-cookie restrictions, expired login, missing host access, or institution-specific restrictions can prevent worker access. Verification must succeed in your Chrome profile; the extension does not scrape pages or work around login restrictions.

The token stays in `chrome.storage.local`, restricted to trusted extension contexts, and is not encrypted by the extension or synced through Chrome. No content script reads your pages. Canvas requests use browser-managed cookies; the extension never reads or copies cookies. It retains minimal assignment identifiers, bounded titles for preview, completion evidence, and up to 100 diagnostic rows for the latest scan. Raw submission content is not retained. Only Canvas and Notion receive network requests.

## Verify a release

Run `npm run lint`, `npm run format:check`, `npm run check:types-and-build`, `npm test`, and `npm audit`. Extension tests can also run alone with `npm run test:extension`.

In Chrome, verify Settings and Preview, navigate while a scan is running, and confirm a qualifying assignment becomes Done. Manually reopen it and confirm another scan preserves the change. Go offline or sign out of Canvas, trigger a scan, and confirm sync stays enabled and recovers once you are back. Click Pause during a scan and confirm it stops promptly. Inspect errors in `chrome://extensions` if needed. These live checks require the unpacked extension, a Canvas login, and the integration token; automated tests use synthetic data only.
