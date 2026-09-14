# Synchronization core

`buildPlan` is a deterministic calculation over a feed, Notion snapshots, configuration, and a supplied time. It performs no I/O and does not mutate its inputs. The provider, Notion schemas, and existing stored data remain compatible; no migration is needed.

## Planning

- `course-catalog.ts` collects course matches and blank-field enrichments in a run-local catalog. Provisional identities remain stable and are never deleted or reused. After collection, source labels/IDs associated with existing courses resolve provisional members. Multiple destinations stay ambiguous; incompatible metadata blocks the affected work. Redirects recheck earlier metadata against the final destination.
- `assignment-decision.ts` computes the permitted property patch and description audit decision for one assignment. Blocked course work can still receive an exact-UID lifecycle update. Due-date override rules remain in `date-resolution.ts`.
- `plan.ts` emits assignment decisions only after course resolution finishes. It returns planning facts (conflicts, avoided/deferred audits, and operation counters) from those final decisions, rechecks duplicate evidence when a course destination changes, and then calls the existing removal-evidence policy with the full protection set. Duplicate Notion UIDs are protected even when absent from the feed.
- `feed-diagnostics.ts` keeps feed diagnostics separate from assignment work. Ordinary calendar events, quarantined source data, and reconciliation skips retain their distinct meanings.

This removes the need to redirect queued assignment patches, undo description metrics, or prune already counted unchanged assignments after a later course conflict.

## Execution and recovery

`commands.ts` compiles the plan into one ordered sequence: course writes, active assignment writes, explicit cancellations, missing evidence, and inferred removals. Both `plannedOperations` and `applyPlan` use that sequence, so failure accounting cannot drift from the actual write order.

`reconcile.ts` executes commands sequentially and stops at the first failure. Its ledger records the successful prefix, the failed or ambiguous command, the unattempted suffix, and assignment substeps requiring repair. Course-key resolution happens inside the recorded command. Create recovery and confirmed-create counters remain separate; an assignment update is counted only after all its commands succeed.

The existing Notion adapters retain responsibility for unique-page recovery, template stabilization, managed-section verification, and ownership-safe property serialization. Description metadata is committed only after body verification. A block append with no visible progress stops as ambiguous rather than appending again; a later run can resume the visible pending replacement. SDK retries are disabled so the gateway's bounded retry policy and physical request metrics are authoritative.

## Reporting and request metrics

- `observability/run-report.ts` derives reporting from the plan, execution ledger, feed diagnostics, and a request snapshot. `buildPlan` takes no mutable metrics/counters; `applyPlan` takes no counts. Adapters return create/description outcomes; managed-section recovery explicitly notifies the execution ledger, including recoveries before a later failure.
- `plannedCounts` describes intended work; `executedCounts` describes confirmed outcomes. Feed diagnostics, unchanged/skipped decisions, and newly observed missing candidates are planning context in both. For compatibility, `counts` selects planned counts in dry runs and executed counts otherwise. A dry run performs reads but has zero executed writes/audits.
- `Created` retains its Sync Log meaning: confirmed assignment page creations, excluding recovered creates. Added pages include both. A created page can still require repair; an assignment update counts only when all its substeps finish. Missing-evidence changes count as soon as their property command succeeds, even if a later description command fails. Failed/ambiguous operations never count as applied; the ledger retains the unattempted suffix.
- Description audits due/deferred/avoided come from planning. Audits run/body reads count attempted logical audits (including a failed read), not HTTP calls or template polling. Passed/repair/replacement metrics require a successful body outcome, even if the subsequent metadata commit fails. `descriptionBodyReadsAvoided` is a compatibility alias of `descriptionUpdatesAvoided`, never an independent counter. The redundant `execution.ambiguousOperations` list was removed; `failedOperation.outcome` is authoritative.
- The required gateway `requestMetrics` contains only physical Notion attempts, operation breakdowns, and read/property retries. Pagination, recovery polling, and failed requests all count; SDK retries remain disabled. Each run subtracts a copied starting baseline, so reusing a gateway cannot contaminate results. Concurrent reads settle before failure finalization.
- Both outputs use a snapshot taken before Sync Log persistence. Requests for report persistence are returned separately as `reportingRequests`; adding these to `metrics` gives the full run's requests. A Sync Log failure changes the returned status/errors without rewriting completed sync work or retrying log creation. A stored log cannot describe its own subsequent persistence failure.
- `observability/report-content.ts` centrally defines aggregate report fields and operation sections. The GitHub Actions summary uses only aggregate status, counts, metrics, warning codes, and a non-identifying failure summary; detailed operation sections remain in the Notion Sync Log. Existing Sync Log properties and report content remain; no new database properties are required.

## Validation

The original fixture, reconciliation, application, description audit, health-monitor, and observability suites remain compatibility checks. `sync-core.test.ts` adds course-order, ambiguity, metadata, duplicate protection, repeated-run convergence, snapshot preservation, and execution-ledger regressions. `recovery-boundaries.test.ts` checks the real SDK retry boundary with mocked HTTP and managed-body recovery after delayed visibility. Application tests can inject a clock so removal-window assertions do not expire with calendar time.
