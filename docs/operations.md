# Operating the boundary

## What success means

A `loaded` receipt means validation passed and the warehouse transaction committed. A duplicate delivery reuses that receipt. It does not prove that every expected vendor published, or that all scraped listings were complete.

An `invalid` receipt acknowledges a permanent contract failure and preserves the archived CSV. Correct the input and publish a new immutable object; do not change the content behind an already acknowledged generation.

Cloud Run returns 503 for transient failures so delivery can retry. Events outside the configured bucket/vendor/path contract are acknowledged as `rejected_event`, with a reason code. The receiver relies on Cloud Run IAM; its binary CloudEvent headers are not authentication.

## Replay the right bytes

The replay key is the digest of **bucket + object path + generation**, not the event ID. Two delivery IDs can refer to the same object. Two generations under the same name are different inputs.

The loader uses generation-bound GCS reads and rejects missing generations. It never silently substitutes the current object. **A small SDK quirk:** the pinned Node Storage client coerces string generations to JavaScript numbers. The cloud adapter rejects generations outside the positive safe-integer range before invoking it, rather than requesting rounded bytes. A future adapter supporting the full unsigned 64-bit generation range needs a string-preserving transport.

Terraform enables archive versioning, but production producers should also use unique object names, create-only uploads, and retention suited to their recovery requirements. Versioning by itself does not make a producer's overwrites safe.

Before replay:

1. Verify the source generation exists and its observation day matches its path.
2. Inspect the receipt and any lock for that vendor/day.
3. Confirm the identity rule and schema have not changed since the original ingestion.
4. Compare distinct IDs and source-listing counts, not only row count.
5. Keep the original raw object and record the recovery evidence.

Replaying the same identity version tolerates duplicate delivery. Replaying after an identity change is a migration.

## Uncertain jobs and orphan locks

Locks are create-only objects in a **separate control bucket**, keyed by vendor/day. The worker deletes only the generation it acquired. Another worker encountering the lock fails and retries.

There is deliberately **no automatic TTL stealing**. A Cloud Run timeout does not prove that its BigQuery transaction stopped. A lost submission or completion response retains both the lock and staging table unless the job is confirmed `DONE`. Query jobs have an `ingestion-lab` component label and generated `merge_…` job IDs. Staging tables have a one-hour expiry as a cleanup backstop.

An operator must:

1. Locate the lock, owning partition and acquisition time.
2. Inspect matching BigQuery jobs in the configured region. Confirm they finished or cancel them and confirm cancellation; inspect recent receiver logs too.
3. Check warehouse rows and the generation's receipt to establish whether commit happened.
4. Back up affected data before a repair.
5. Only after excluding a live writer, remove the **observed lock generation** with a generation precondition.
6. Re-deliver the original event if needed. If a commit occurred without a receipt, the merge remains idempotent.

The lab does not implement this operator workflow. An orphan can block progress until handled. Eventarc retries are bounded by message retention; after retention expires, recovery requires explicit replay from the archive. Keep receipts as long as you need duplicate suppression.

## Changing identity

The fixture has two milk listings with the same title and different URLs/prices, plus two keyboards with the same title. Name-based keys collapse eight rows to six. URL-aware IDs preserve all eight. Loading new IDs on top of old ones produces fourteen rows because MERGE inserts new keys; it cannot infer which old keys are obsolete.

The browser repair keeps a snapshot **in memory for that simulation**, replaces one synthetic partition, and checks that all eight source listings are present. The snapshot is ephemeral, not a durable backup.

For an actual migration:

- Back up every affected partition into a separately named, access-controlled table with an explicit recovery period.
- Derive replacement rows from preserved source generations using a named identity version.
- Verify uniqueness, count, source URLs, amounts and timestamps before mutating the target.
- Replace only the intended vendor/day in a transaction; assert preconditions and replacement counts.
- Compare after commit, retain the backup and update associated receipts/audit records as appropriate.

Do not add a generic repair button to the event receiver. A migration deserves a bounded, reviewable operator operation.

## The failure before the first event

The upload-denial scenario shows a gap that an event consumer cannot fix: collection finishes but GCS rejects publication. No object exists, so no finalized event arrives.

A complete platform also needs a separate expected-publication monitor, using declared vendor schedules and their output contract. Monitor at least:

| Boundary | Signal |
|---|---|
| Collection | Execution started/finished, errors, expected completeness |
| Publication | Expected object exists, generation, byte size, source row count |
| Ingestion | Receipt status, warehouse count, latest observation time |
| Recovery | Retry age, invalid receipts, orphan locks, unresolved partitions |

Warehouse emptiness alone does not identify which boundary failed. Collector logs alone do not prove publication. The lab documents this monitor but does not deploy one.

## Deliberate scope limits

- Inputs are small, trusted-schema CSVs; no arbitrary table names or user SQL.
- UTC dates are strict; producers must split files across midnight.
- Equal-time, conflicting prices reject instead of guessing which is right.
- The target retains the latest daily observation, not every intraday event.
- Partition-scoped MERGE reduces the target scan; the billing cap still covers the submitted script's query jobs, not the whole project's bill.
- The loader can read the raw archive but cannot write or delete its source objects.
- Raw and control retention is indefinite in the example. Choose and price a retention policy before a real rollout.
- The demo's counters and local benchmark are not GCP latency or billing measurements.
