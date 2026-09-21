# Chrome companion

This personal, unpacked extension marks existing Notion assignments **Done** using your logged-in Canvas session. The scheduled ICS importer continues to create assignments and maintain their metadata. No Notion schema changes or Canvas API token are needed.

## Install and connect

1. Run `npm ci` and `npm run build:extension` (Node 24).
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this repository's `dist/extension` directory.
3. Sign in to Canvas in that Chrome profile. Open the extension's **Settings**.
4. Enter the Canvas HTTPS origin from your browser (without a path), your Assignments **data-source ID**, and a Notion integration token with read/update access to that database. You can use the existing integration; a dedicated integration shared only with Assignments reduces its access.
5. Click **Verify and save**, granting access to that Canvas host. Verification performs read-only Canvas session and Notion schema checks. A blank token retains the saved token.
6. Run **Preview** and review the matching assignments and reasons. Then choose **Enable sync**, followed by **Sync now** for your initial sync.

Automatic checks run on visits, navigation, tab activation, and window focus, at most once every five minutes. While Canvas is the active tab of the focused window, an alarm checks whether another scan is due. Once started, a scan continues across navigation or closing the Canvas tab. **Pause** cancels remaining scan work and turns automatic sync off until you choose **Enable sync** again; changes already sent cannot be undone. **Sync now** bypasses the cooldown but respects Pause and completion history.

After updating the source, rebuild and click **Reload** on the extension in Chrome. Keep the same unpacked directory to preserve its local history.

## Matching and completion

Assignment IDs come first from Canvas UID (such as `event-assignment-123`), falling back to assignment URLs. This supports imported pages with blank URLs. Conflicting identities, duplicates, and removed pages are skipped. Active courses are read first; completed enrollments are read only while a tracked assignment is still unaccounted for. Assignments in courses Canvas will not let you read are reported as unchecked. So are those in a course that keeps failing; one broken course does not hold back the rest, and the scan fails only when no course could be read. Canvas IDs are handled as text, so 64-bit IDs match exactly.

An assignment ID is unique only within one Canvas, so an ID match alone does not prove a page came from this Canvas. Before anything is written, the page's title must also equal the assignment's name in Canvas, ignoring case and spacing. The importer keeps the title equal to that name, so pages imported from another Canvas are refused wherever the title differs, and Preview shows each one as "Title differs from Canvas". This is corroboration, not proof: a page from another Canvas would still pass if that Canvas and this one happened to use the same assignment ID for work with the same name. The pages hold nothing that identifies their Canvas outright, because the feed's calendar links are not stored. Point the extension only at the database imported from this Canvas, and read Preview before enabling sync. A page you renamed by hand, or an assignment renamed in Canvas since the last import, is skipped the same way until the importer restores the title. When a page has an assignment URL, its course ID must match too. Hostname aliases in Notion links do not affect identity and are never used as request destinations.

The extension sets only **Personal Status** to **Done** for actual submissions, excused work, or graded work not marked missing. A zero grade counts unless Canvas marks it missing. A grade of "incomplete" on work that was never submitted does not count. Redo requests are deferred. No grades, submissions, descriptions, or dates are written into Notion.

Completion is acknowledged locally per page and submission attempt. Later grading or excusal of the same attempt does not override a manual reopening; a new submission attempt may set Done again. Existing Done pages are acknowledged without writing. Clearing extension storage or removing/reinstalling the extension loses this history, so review Preview afterward. The first scan cannot know about manual reopenings made before installation.

## Recovery and privacy

A scan runs in one pass and keeps its progress only in memory. If Chrome stops the worker midway, the popup shows that scan as interrupted and the next trigger simply scans again; nothing needs repair. This is safe because each page is reread immediately before it is written, and handled submissions are saved as soon as each page is dealt with. Temporary failures are retried a few times within the scan. A write whose outcome is unknown is rechecked by the next scan: a page that became Done is acknowledged without writing, and one that did not is written again. Preview never writes or consumes completion acknowledgements.

An expired Canvas login, a network outage, throttling, or a service error ends that scan with a message and leaves automatic sync on; it tries again after a minute once Canvas is visited or visible, or after the wait the service asked for (up to an hour). **Sync now** does not wait. Withdrawing the extension's access to the Canvas site in `chrome://extensions` is reported by name and also leaves sync on, since restoring access is all it takes. Apart from **Pause**, three things turn automatic sync off, because none of them passes by itself: a changed Canvas account, a Notion schema that no longer fits, and an integration that can read pages but is refused when it updates one. For the last, give the integration **Update content** access in Notion, then verify Settings again.

Changing Canvas accounts turns syncing off; sign into the intended account, verify Settings again, then run Preview and enable sync. Changing the configured instance, account, or Notion data source starts fresh local history. Session-cookie restrictions, expired login, missing host access, or institution-specific restrictions can prevent worker access. Verification must succeed in your Chrome profile; the extension does not scrape pages or work around login restrictions.

The token stays in `chrome.storage.local` and is not encrypted by the extension or synced through Chrome. The extension has no content script, so no web page can read that storage or your pages; on Chrome 140 and later the storage is additionally restricted to trusted extension contexts. Canvas requests use browser-managed cookies; the extension never reads or copies cookies. It retains minimal assignment identifiers, bounded titles for preview, completion evidence, and up to 100 diagnostic rows for the latest scan. When a scan has more rows than that, failures, eligible and updated assignments, and unchecked courses are kept ahead of routine skips, and the report says how many rows it left out; the totals always count every assignment. Raw submission content is not retained. Only Canvas and Notion receive network requests.

## Verify a release

Run `npm run lint`, `npm run format:check`, `npm run check:types-and-build`, `npm test`, and `npm audit`. Extension tests can also run alone with `npm run test:extension`.

In Chrome, verify Settings and Preview, and check that Preview reports no "Title differs from Canvas" rows for assignments you recognize. Navigate while a scan is running, and confirm a qualifying assignment becomes Done. Manually reopen it and confirm another scan preserves the change. Go offline or sign out of Canvas, trigger a scan, and confirm sync stays enabled and recovers once you are back. Click Pause during a scan and confirm it stops promptly. Inspect errors in `chrome://extensions` if needed. These live checks require the unpacked extension, a Canvas login, and the integration token; automated tests use synthetic data only.
