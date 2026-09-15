# Scheduled health monitor

This document is the authoritative policy for `.github/workflows/health-check.yml`, which runs `scripts/check-health.ts` every four hours. The checker reads only `sync.yml` runs with `event: schedule`; manual runs never improve or degrade scheduled health and cannot recover an incident. It needs no npm dependencies, so the workflow runs the TypeScript source directly on Node 24 without installing or building anything.

## Run classification

Scheduled runs are ordered newest first by `updated_at`, which is the completion time of a completed run. A completed run with conclusion `success` is a success. A completed run with conclusion `failure`, `timed_out`, `action_required`, `startup_failure`, or `cancelled` is a failure. Any other completed conclusion (`neutral`, `skipped`, `stale`, and unknown values) is neither: it counts as a completion that breaks a run of consecutive failures, but it is not a success. Queued, pending, requested, waiting, and in-progress runs are active, not completed.

## Alert conditions

The scheduled sync is unhealthy when any of these holds:

- The workflow state is anything other than `active`. This alerts immediately and suppresses the other checks, because no scheduled run can start.
- The three most recent completed scheduled runs are failures.
- The latest scheduled success is older than 13 hours (a 12-hour watchdog plus one hour of scheduler delay). With no scheduled success at all, the deadline is instead 14 hours after the workflow was last activated, where activation is the workflow's `updated_at` (falling back to `created_at`). `HEALTH_ACTIVATION_GRACE_HOURS` can set another positive number of hours.

A scheduled run that is still active and was created within the previous two hours defers the no-success alert only; it never masks completed failures, and a run stuck in the queue for longer than two hours no longer defers anything.

## Issue lifecycle

The checker keeps one issue titled `Canvas–Notion sync is unhealthy` with the `sync-failure` label. The label is created on first use, and the oldest matching issue is reused. The labeled-issue listing is paginated (up to ten pages of 100), so newer labeled issues can never hide the durable one, and pull requests returned by the issues endpoint are ignored.

- Unhealthy and no issue exists: the issue is created.
- Unhealthy and the issue is closed: the same issue is reopened with a fresh body.
- Unhealthy and the issue is open: the body is patched only when its content changed. Line-ending differences from manual edits do not count as changes.
- Healthy and the issue is open: the issue is closed only when a scheduled success is strictly newer than the latest scheduled failure. That excludes an older success still inside the watchdog, a success at the same timestamp as a failure, a manual success, and a fresh activation grace with no successes. When a disabled workflow is re-enabled, the issue closes as soon as the other checks pass.
- Healthy and the issue is closed, or no issue exists: nothing happens.

Closing patches the issue first and then adds one comment naming the recovering run. Because the state change comes first, a failed comment request can never lead to a duplicate comment on the next check. Repeated healthy checks do not comment or close again, and reopening requires a genuinely new unhealthy condition, so the issue cannot flap.

## GitHub API access

Requests go to the repository's `actions` and `issues` endpoints with the workflow token. Reads and idempotent `PATCH` requests retry twice on network failures, server errors, and rate limiting, where rate limiting means a `429` or a `403` carrying `Retry-After` or `x-ratelimit-remaining: 0`. A `Retry-After` header sets the delay, capped at ten seconds; otherwise the delay grows by one second per attempt. `POST` requests are never retried. Error messages include the method, path, and status only, never the token or the response body.

`HEALTH_ACTIVATION_GRACE_HOURS` must be a positive finite number; anything else fails the check before any request is made.

## Data and privacy

Issue bodies contain only workflow metadata: run identifiers and links, attempt numbers, status and conclusion, short commit SHAs, timestamps, and the workflow state. They exclude secrets, credentials, environment variables, feed contents, assignment and Notion data, and application logs.
