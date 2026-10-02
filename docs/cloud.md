# Optional Cloud Run + Eventarc + BigQuery

The local lab is enough to explore the behavior. These assets are an optional deployment starting point for a separate sandbox project. They have SDK import, mocked adapter and Terraform validation checks; **no live end-to-end GCP deployment has been verified**.

## Runtime

`cloud/Dockerfile` installs the exact SDK versions from `cloud/package-lock.json`, copies only the runtime source, and runs as the unprivileged Node user. SDKs authenticate through the service identity/Application Default Credentials. No service-account key file is needed.

```sh
docker build -f cloud/Dockerfile -t ingestion-lab .
```

Build and push the resulting image to a repository you control. Use an immutable image digest in Terraform. The example does not create an Artifact Registry repository or CI identity.

The cloud SDK lock includes a scoped `gaxios → uuid@11.1.1` override for [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). Gaxios's UUID v4 interface remains available. Keep the override under review when updating the official SDK dependencies.

Required configuration:

| Variable | Purpose |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | Your sandbox project |
| `BQ_DATASET` | Existing dataset with the `observations` table |
| `BQ_LOCATION` | Same region as the table |
| `ARCHIVE_BUCKET` | Read-only CSV archive |
| `CONTROL_BUCKET` | Separate receipt/lock store |
| `VENDORS_JSON` | Vendor-to-domain allowlist; e.g. `{"mercado-demo":"retail"}` |

The receiver consumes Eventarc's binary CloudEvent JSON request. It caps the event body at 16 KiB and the downloaded CSV at 1 MiB. Protect its Cloud Run invocation with IAM; never grant `allUsers`.

## Infrastructure

The Terraform root creates:

- Region-aligned GCS archive/control buckets, Eventarc trigger, Cloud Run service and BigQuery dataset.
- An observation table partitioned by day, clustered by source/product ID, with partition filters required.
- Separate **delivery** and **loader** service accounts.
- Scale-to-zero compute, request concurrency of one and a maximum of two instances.
- Versioned archive storage, public-access prevention, and deletion protections for durable resources.

IAM boundaries:

| Identity | Access |
|---|---|
| Eventarc delivery | Event receiver role; invoke this Cloud Run service |
| Loader | Read archive objects; read/create/delete control objects; edit this dataset; run BigQuery jobs |
| Cloud Storage service agent | Publish transport events |
| Producer | Not provisioned here; give a separate identity create-only access to its archive prefix |

The loader needs dataset-level edit access for temporary staging tables. It has no project-wide data-editor grant. Nothing in this example grants it mutation rights to the archive.

## Validate and review

```sh
cd terraform
terraform init -backend=false
terraform fmt -check
terraform validate
cp terraform.tfvars.example terraform.tfvars
```

Edit the example values for your isolated sandbox. Configure a secured remote state backend and a short-lived CI identity, then review a plan in CI. This repository's CI **validates only**; it does not apply infrastructure or authenticate to a GCP project.

API enablement and IAM propagation can take time on a new project. Older Pub/Sub service-agent configurations may need additional token-creation permissions; follow [Google's current trigger setup guide](https://docs.cloud.google.com/eventarc/docs/creating-triggers-terraform). Do not work around propagation failures with a public receiver.

Deletion protections are intentional. Decommission through a reviewed change after archiving or verifying the data you intend to retain. Do not disable them simply to make a failed deployment clean itself up.

## Smoke test after a sandbox deployment

1. Publish the synthetic fixture once under `retail/mercado-demo/2026/06/01/catalog-unique.csv`.
2. Confirm a finalized event produces a `loaded` log and receipt.
3. Query exactly that day/vendor: eight distinct identities and eight rows, with original USD amounts.
4. Re-deliver the exact same generation and check duplicate behavior without another staging load.
5. Publish a schema-invalid fixture under another immutable name; confirm an invalid receipt and unchanged target.
6. Verify raw objects remain in the archive and the loader cannot overwrite/delete them.
7. Check logs, jobs, receipts and publication freshness independently.

Do not confuse successful Terraform validation with these runtime checks.

See [operations](operations.md) before testing outages, expired retries or identity migrations.
