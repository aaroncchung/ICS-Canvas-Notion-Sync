# Synchronization core

`buildPlan` is a deterministic calculation over a feed, Notion snapshots, configuration, and a supplied time. It performs no I/O and does not mutate its inputs. The provider, Notion schemas, public plan/result shapes, and existing stored data remain compatible; no migration is needed.

## Planning

- `course-catalog.ts` collects course matches and blank-field enrichments in a run-local catalog. Provisional identities remain stable and are never deleted or reused. After collection, source labels/IDs associated with existing courses resolve provisional members. Multiple destinations stay ambiguous; incompatible metadata blocks the affected work. Redirects recheck earlier metadata against the final destination.
- `assignment-decision.ts` computes the permitted property patch and description audit decision for one assignment. Blocked course work can still receive an exact-UID lifecycle update. Due-date override rules remain in `date-resolution.ts`.
- `plan.ts` emits assignment decisions only after course resolution finishes. It computes counts and audit metrics from those final decisions, rechecks duplicate evidence when a course destination changes, and then calls the existing removal-evidence policy with the full protection set. Duplicate Notion UIDs are protected even when absent from the feed.
- `feed-diagnostics.ts` keeps feed diagnostics separate from assignment work. Ordinary calendar events, quarantined source data, and reconciliation skips retain their distinct meanings.

This removes the need to redirect queued assignment patches, undo description metrics, or prune already counted unchanged assignments after a later course conflict.

## Execution and recovery

`commands.ts` compiles the plan into one ordered sequence: course writes, active assignment writes, explicit cancellations, missing evidence, and inferred removals. Both `plannedOperations` and `applyPlan` use that sequence, so failure accounting cannot drift from the actual write order.

`reconcile.ts` executes commands sequentially and stops at the first failure. Its ledger records the successful prefix, the failed or ambiguous command, the unattempted suffix, and assignment substeps requiring repair. Course-key resolution happens inside the recorded command. Create recovery and confirmed-create counters remain separate; an assignment update is counted only after all its commands succeed.

The existing Notion adapters retain responsibility for unique-page recovery, template stabilization, managed-section verification, and ownership-safe property serialization. Description metadata is committed only after body verification. A block append with no visible progress stops as ambiguous rather than appending again; a later run can resume the visible pending replacement. SDK retries are disabled so the gateway's bounded retry policy and physical request metrics are authoritative.

## Validation

The original fixture, reconciliation, application, description audit, health-monitor, and observability suites remain compatibility checks. `sync-core.test.ts` adds course-order, ambiguity, metadata, duplicate protection, repeated-run convergence, snapshot preservation, and execution-ledger regressions. `recovery-boundaries.test.ts` checks the real SDK retry boundary with mocked HTTP and managed-body recovery after delayed visibility. Application tests can inject a clock so removal-window assertions do not expire with calendar time.
