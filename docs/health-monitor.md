# Scheduled health monitor

The health checker examines only completed or active scheduled runs of `sync.yml`. Manual runs never affect scheduled health. It opens or reuses the durable `Canvas–Notion sync is unhealthy` issue for three consecutive qualifying failures, absence of a recent scheduled success after the configured activation grace, or a workflow state other than `active`. A disabled workflow produces the immediate reason code `workflow_disabled`; it is not treated as scheduler delay.

Each unhealthy episode stores deterministic, secret-free markers for its incident start and latest qualifying failure run ID and completion timestamp. While the issue remains open, a newer qualifying failure advances only the latest-failure boundary. Pull requests returned by GitHub's issues endpoint are excluded before durable-issue matching.

The issue closes only when current health is otherwise healthy and a completed scheduled `success` is strictly newer than both incident markers. Neutral, skipped, stale, queued, in-progress, and manual runs never recover an incident. Legacy issues without incident markers use the newest displayed qualifying failure, falling back to issue timestamps when GitHub provides them; without a parseable conservative boundary, the checker leaves the issue open. Recovery comments use an episode marker so retries add at most one comment, and identical issue bodies are not patched.

Issue bodies contain workflow metadata only. They exclude feed contents, assignment and Notion data, environment variables, logs, credentials, and authentication headers.
