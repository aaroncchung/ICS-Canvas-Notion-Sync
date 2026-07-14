# Scheduled health monitor

This document is the authoritative policy for `.github/workflows/health-check.yml`. The checker evaluates `sync.yml` using UTC timestamps and only scheduled runs (`event: schedule`). Manual runs are excluded completely: they cannot improve or degrade scheduled health and a manual success cannot recover an incident.

## Run classification and alert conditions

Runs are sorted newest first by completion/update/start/create timestamp. A completed `success` is healthy. Completed `failure`, `timed_out`, `action_required`, `startup_failure`, and scheduled `cancelled` runs are qualifying failures. Completed `neutral`, `skipped`, `stale`, and unknown non-success conclusions are neutral: they do not count as failures, break a consecutive-failure sequence, and do not count as successes. Queued, pending, requested, waiting, and in-progress runs are active rather than completed failures.

The checker reports unhealthy state when any of these conditions applies:

- The three most recent completed scheduled runs are qualifying failures. A neutral completion between failures breaks the sequence.
- No scheduled success exists after the initial activation grace ends.
- The latest scheduled success is older than the 12-hour watchdog plus the 60-minute scheduler-delay allowance.
- The workflow state is anything other than `active`; this opens an immediate `workflow_disabled` incident instead of treating the state as scheduler delay.

The default initial activation grace is 14 hours. `HEALTH_ACTIVATION_GRACE_HOURS` can set another positive number of hours. Until the first scheduled success, the activation reference is the workflow's `updated_at`, falling back to `created_at` when `updated_at` is unavailable. Activation grace suppresses only the no-success condition; three actual qualifying failures still alert.

A scheduled active run created within the previous two hours defers a no-success alert. The same deferral applies while a prior success is between 12 and 13 hours old, which combines the 12-hour watchdog with the 60-minute scheduler-delay allowance. Recent active runs do not erase completed failures.

## Durable incident lifecycle

The checker reuses one issue titled `Canvas–Notion sync is unhealthy` with the `sync-failure` label, creating the label when necessary. Pull requests returned by GitHub's issues endpoint are excluded before durable-issue matching. A later unhealthy episode reopens the same closed issue rather than creating another.

Each episode has deterministic, secret-free markers for its episode ID, incident start, and latest qualifying failure run ID and completion timestamp. A three-failure incident starts at the oldest of the three triggering failures; other incidents start at the latest qualifying failure when one exists, otherwise at workflow activation. While an issue remains open, only a strictly newer qualifying failure advances the latest-failure marker. The generated issue body is patched only when its content changes.

Legacy marked issues without current incident markers migrate conservatively. The checker uses the newest qualifying failure timestamp displayed in the old body, then falls back to the issue `updated_at` or `created_at`. If no parseable boundary exists, it leaves the issue open.

## Recovery

An open issue closes only when current health is otherwise healthy and a completed scheduled success is strictly newer than both the incident start and the latest qualifying failure boundary. A success at the same timestamp does not recover the incident. Neither an older success still inside the watchdog nor a manual success, neutral completion, queued run, or in-progress run can recover it.

Recovery adds one comment per episode using a deterministic marker, so retried health checks do not duplicate the comment. Repeated healthy checks do not comment or close again.

## Data and privacy

Issue bodies contain only workflow metadata needed for diagnosis: run/attempt identifiers, links, event, status/conclusion, branch, commit, and timestamps. They exclude secrets, credentials, authentication headers, environment variables, feed contents, assignment data, Notion data, complete descriptions, and application logs.
