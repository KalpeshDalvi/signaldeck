# SignalDeck -> Codex / VS Code continuity handoff

**Prepared:** 2026-11-25. **Last user-verified GCP runtime observations:** 2026-11-18 ~18:14 Central (2026-11-19 ~00:14 UTC). This file is a handoff, **not an automatic live-state probe**. Reverify all live assertions before changing infrastructure.

## 1. End goal and scope

SignalDeck is an incident-first cloud/SRE investigation platform. It should be the place an on-call engineer opens when something breaks. It must:

1. detect affected services and quantify errors/latency;
2. inspect real application errors, exception messages, distributed traces, dependencies, GKE pod/deployment/events, and authenticated change/audit logs;
3. distinguish **symptom** from **observed failure mechanism**, **initiating operation/actor**, and **unproven upstream intent**;
4. form a causal graph and rank alternative explanations by **traceable evidence IDs**, never hallucinating root causes from co-occurrence;
5. propose immediate containment/recovery, a durable prevention measure (e.g., guardrails, deployment policy, permission limitation), and objective post-fix checks;
6. retain immutable source-attributed investigation evidence after shorter-lived raw telemetry expires, with workspace isolation and privacy controls;
7. ultimately support opt-in, cost-controlled AI-assisted investigative reasoning, notifications, ownership, postmortems and human-approved remediations.

A user-facing output should say *why it failed*, with exact logs and change evidence, not merely "inventory failed" or "workload instability." An example incident: a GKE Deployment receives an authenticated `deployments.scale.patch` request to **0** desired replicas; actual endpoints disappear, checkout's dependency calls fail, and requests return HTTP 500. Audit logs verify *that the API operation occurred*, but do not establish human intent or a complete application causal chain without contemporaneous application data.

Never claim a verified cause where supporting evidence is missing.

## 2. Architecture: actual GCP lab and next planned investigator

```text
      GKE Autopilot cluster: signaldeck-lab (us-central1)
       traffic-generator -> checkout -> inventory
                                 |
                          OpenTelemetry SDK
                                 v
           signaldeck-collector (OTLP/gRPC :4317)
             also watches K8s deployments/pods/events
                                 |
                         OTLP/HTTP exporter
                                 |
                                 v
                    Cloud Run: signaldeck-ingest
               /v1/traces, /v1/logs, /v1/metrics
                                 |
            +--------------------+---------------------+
            |                                          |
            v                                          v
Cloud SQL PostgreSQL:                        Cloud SQL PostgreSQL:
public.telemetry_events                      public.investigations
(shorter retention; source telemetry)        public.investigation_evidence
                                             (separate retained snapshots)
            |                                          |
            +----------------+-------------------------+
                             v
                  Cloud Run: signaldeck-read-api
                  workspace-scoped read-only API
                             |
                             v
                 Cloud Run: signaldeck-dashboard
           /overview /incidents /correlation /traces
           /logs /kubernetes /investigations
                             ^
                             |
                      SRE via browser

GKE Cloud Audit Logs --(read-only lookup)--> planned/implemented-in-code
                                  Cloud Run Job: signaldeck-investigator
                                          |
                            enriching archived investigations
                                          |
                              optional Vertex AI hypothesis (OFF)
```

Existing code: Next.js 16 + TypeScript dashboard in `app/` and `lib/`; Node.js ingestion, read API and investigator; PostgreSQL Cloud SQL; GKE + OpenTelemetry collector. Live project `signaldeck-lab-kd`, region `us-central1`, Cloud SQL `signaldeck-db`. The same GCP project may host **Spacical Interiors**, whose indirect DB dependencies are not fully ruled out: DO NOT stop shared SQL, delete the cluster, change other services, or delete infrastructure.

Critical repo paths:
- `app/investigations/`, `app/correlation/`, `app/traces/` — key UI workflows.
- `lib/investigation-archive.ts` — authenticated server-side archived-investigation fetch.
- `cloud-run-ingest/server.js`, `investigation-archive.js` — OTLP normalization, transactional archive writer.
- `cloud-run-read-api/server.js` — workspace-bound read API.
- `cloud-run-investigator/job.js`, `core.js`, `ai-analyst.js` — separate audit-enrichment job + optional Vertex module; source exists but live deployment unverified.
- `cloud-sql/migrations/001_bootstrap.sql`, `003_durable_investigations.sql`, `003_archive_runtime_grants.sql`.
- `incident-lab/k8s/collector.yaml`, `incident-lab/k8s/incident-lab.yaml`, `incident-lab/checkout/app.py`.
- `scripts/release-m3-cloudshell.sh`, `.github/workflows/product-validation.yml`.
- `docs/product-roadmap.md`, `docs/product-architecture-and-release.md`, `docs/milestone-3-deployment.md`.

**Roadmap caveat:** `docs/product-roadmap.md` includes early M0-M8 aspirations and older Supabase/Vercel design. The live lab uses **Cloud Run + Cloud SQL**. Do not undo this architecture on the basis of the historical roadmap.

## 3. Milestones: what actually happened, and what is still open

| Stage | Verified/observed outcome | Remaining work |
|---|---|---|
| M0 / prototype | Next.js observability UI, authenticated OTLP ingestion, service and traces views were built | Cleanup/demo polish |
| GKE integration | checkout -> inventory traces, parent/child spans, Kubernetes data and lab traffic observed; correlation dashboard and time filters built | Verify collector coverage after any config change |
| Evidence-based correlation | Correlation hypothesizes downstream inventory cause; historical GKE audit reveals scale-to-zero operation + initiating identity | Confirm causation only with matching app evidence, reduce false positives |
| M3 archive code | Ingest archive, read API, Saved Investigations UI and DB migrations implemented and validated in CI | Live archive-to-UI end-to-end evidence acceptance **NOT PASSED** |
| M3 Cloud SQL | Fresh on-demand backup ID `1795043793223` successful on 2026-11-18; `public.investigations` and `public.investigation_evidence` verified existing | DB grants reportedly applied; verify from live SQL if needed |
| M3 Cloud Run | `signaldeck-read-api-00010-48x`, `signaldeck-ingest-00006-fcd`, `signaldeck-dashboard-00018-1h2` were deployed, 100% traffic as of 2026-11-18 | Verify current revisions, /ready and ingestion |
| M3 feature flag | Operator said archive permission/feature-flag steps were completed | **NOT independently confirmed**: /ready with `archive_enabled:true` was not shown |
| Audit investigator | Separate Cloud Run Job code exists; deterministic audit matching + optional Vertex AI with evidence-ID validation | Configure least-privilege identity, Cloud SQL access, run/schedule, and test in GCP; AI remains disabled |
| Product completion | Dashboard read-only list appeared working | Live persisting a new qualifying failed request + evidence read-back, history retention, alerting, trusted RCA, tenant/privacy hardening |

The original release roadmap in `docs/product-roadmap.md` calls separate streams M0 (prototype), M1 (incident center), M2 (persistence), M3 (change correlation), M4 (tracing), M5 (Kubernetes), M6 (SRE assistant), M7 (notifications), M8 (scale). Those remain product-level milestones, not reliable implementation status. The working team has also called the **durable archive rollout** “Milestone 3”; use the specific feature name to avoid ambiguity.

## 4. Verified GitHub and rollout checkpoints

- Repository: `KalpeshDalvi/signaldeck`.
- PR #5 merged to `main` on 2026-11-18 as `f23415da6ccfd71f5044b891e0953bef0e4f7854`. GitHub Actions validation passed (Node, Next build and disposable PostgreSQL tests).
- `main` most recently observed (before this handoff) at `192c6f2ddc...` on 2026-11-18. Check actual `git log -1` on the Mac.
- GitHub issue #7 is the authoritative human rollout log: https://github.com/KalpeshDalvi/signaldeck/issues/7
- Existing direct GitHub WIF inventory workflow worked; do not replace it with PR #6 as a prerequisite.
- Cloud Run dashboard Saved Investigations page loaded the *successful empty list* state; direct Cloud Shell/proxy requests to read API `/healthz` returned GFE HTML HTTP 404, likely a different auth/access path. Do **not** make the read API public to silence that diagnostic. Source code confirms dashboard-to-read-API list uses a Cloud Run ID token + API key.
- Around 2026-11-18 18:13-18:14 Central, both UI and SQL query showed **no rows** in `public.investigations`. No successful archive capture has been demonstrated. The preceding test’s HTTP 500 and ingest readiness status were not provided.

## 5. Immediate active blocker: NO SAVED INVESTIGATIONS

Last known UI: “No saved investigations yet”. SQL in database `signaldeck`, workspace `default`, returned zero investigation rows. **DO NOT claim M3 end-to-end passed.**

A real failed checkout request may not have been sent, or its OTel span may not have been exported, the collector may point to a stale endpoint, request may have been rejected (401/403), Cloud Run ingestion may have failed (503/DB), archive flag may be off, or workspace might mismatch. Investigate rather than guessing.

**Highest-priority safe diagnostic order (read-only):**

1. `gcloud run services describe signaldeck-ingest --project=signaldeck-lab-kd --region=us-central1`, then authenticated GET `/ready`. Require HTTP 200 JSON `{"status":"ready","archive_enabled":true}`. A 401/404 from Cloud Shell may be an invocation-context issue; compare service-to-service routes.
2. Verify runtime permissions and `default` workspace in Cloud SQL via read-only SQL; do not paste credentials into Codex or commits.
3. Check `gcloud logging read` for ingest POST statuses and errors from the current revision; distinguish `202` versus `401/403/404/503`.
4. **Inspect the running collector ConfigMap and environment**, not just GitHub's manifest. `incident-lab/k8s/collector.yaml` still contains an obsolete Vercel OTLP URL by default; the live value may have been overridden. Check for exporter `otlphttp/signaldeck` error/retry messages and that the target is the Cloud Run `signaldeck-ingest` API with correct authentication. The collector must be allowed to invoke the service under existing IAM.
5. Query fresh raw `public.telemetry_events` by `workspace_id='default'`, `signal_type='trace'`, newest timestamp and error/status. If fresh failed traces arrive but archive remains empty, inspect `archiveBatch`/transaction/DB privileges.
6. Only after a healthy pipeline and the operator’s authorization: trigger **one** non-destructive lab checkout test from traffic-generator using `curl -X POST -H 'x-failure-mode: error' http://checkout:8080/checkout`. This deliberately yields HTTP 500 for that single request without changing deployment replicas or env. It must produce an error trace, a new `investigations` record, `investigation_evidence` with stable source ID/time, and a readable dashboard record.
7. Replay same source event safely to verify dedup; ensure healthy trace makes no incident; query read-only archive evidence and ensure no cross-workspace data leakage; record tests in issue #7.

**Most recent read-only script from the prior conversation:**

```bash
PROJECT=signaldeck-lab-kd
REGION=us-central1
URL="$(gcloud run services describe signaldeck-ingest --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
curl -sS --max-time 15 -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/ready"
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="signaldeck-ingest" AND httpRequest.requestMethod="POST"' --project="$PROJECT" --freshness=45m --limit=20 --format='table(timestamp,httpRequest.status,httpRequest.requestUrl)'
gcloud container clusters get-credentials signaldeck-lab --region="$REGION" --project="$PROJECT"
kubectl -n signaldeck-system get cm signaldeck-collector-config -o json | jq -r '.data["collector.yaml"]' | grep -A 9 'otlphttp/signaldeck:'
kubectl -n signaldeck-system logs deployment/signaldeck-collector --since=30m --tail=50 | grep -Ei 'error|failed|retry|timeout|unauthorized' || true
```

On the Mac, confirm `gcloud`, GKE auth plugin, `kubectl`, `jq` and `gh` are installed and authenticated before the read-only commands. If deploying runtime changes, get explicit approval and include rollback. **Do not scale inventory to zero** to test a feature that can be exercised using a single request.

## 6. Acceptance criteria and work after the immediate blocker

**M3 durable archive acceptance:**
- A newly ingested, authentic failed lab span creates a persistent investigation and at least one immutable evidence record.
- Source ID, original event timestamp, source type, observation/capture timestamps and reasoned limitation are visible.
- Read API and dashboard show it; raw telemetry is not required to display the archived evidence.
- Replaying event does not duplicate evidence; healthy signal is not archived as a failure.
- Workspaces are isolated; read-only API never gains writer permission.
- Write errors are explicit and collector retries are observable; do not misrepresent missing data as a healthy system.

**Next product streams (in logical order):**
1. Complete live M3 capture/availability/retention acceptance and harden collector routing.
2. Deploy and prove the **separate investigator job** for GKE audit change and initiating actor, with least privilege, no blind rule-based causality.
3. Build higher-fidelity RCA: collect stack traces and relevant exception excerpts, compare failed vs healthy paths, correlate precise Kubernetes and deployment timelines, evaluate alternative hypotheses, and recommend **permanent** preventive fixes with validation checks.
4. Add optional evidence-cited Vertex AI analyst behind explicit `SIGNALDECK_AI_ENABLED=true`, PII redaction, strict quotas and billing guardrails. Keep hypotheses distinct from verified mechanisms. Tests should show failures cannot be explained from missing evidence.
5. Notifications, incident lifecycle, saved postmortems, RBAC/tenant isolation, managed retention, reliability, observability of SignalDeck itself, and performance/cost gates.

## 7. Safe development workflow on the new Mac

```bash
gh auth login
gh repo clone KalpeshDalvi/signaldeck
cd signaldeck
git status --short
git log -1 --oneline
npm ci
node --check cloud-run-ingest/server.js
node --check cloud-run-read-api/server.js
node --check cloud-run-investigator/job.js
node --test cloud-run-ingest/test/archive.test.mjs
npm run build
```

Follow `AGENTS.md`; ask Codex to first produce a verified vs unverified status table and read-only diagnostics. Changes go on a new branch/PR with tests. Never assume this handoff reflects real-time GCP state; update it after each accepted milestone.

## 8. First Codex prompt

> Read AGENTS.md, docs/CODEX_HANDOFF.md, docs/product-architecture-and-release.md, docs/milestone-3-deployment.md, docs/product-roadmap.md and GitHub issue #7. Inspect the current main branch, source, CI and relevant tests. Do not rebuild completed milestones or infer current GCP health from older screenshots. Our immediate blocker is zero persisted archived investigations after enabling the feature flag was reported. Start with a plan and safe read-only diagnosis of ingest readiness, collector endpoint/exporter, Cloud Run POST statuses and recent PostgreSQL traces. Identify the first broken link and propose a minimal tested fix, without destructive operations, IAM broadening, GKE scaling or database shutdown. Ask for explicit approval before live GCP changes. Once approved and verified, run a single-request controlled failure, prove a saved investigation with source evidence, and update GitHub issue #7 and this handoff.
