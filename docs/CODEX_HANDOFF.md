# SignalDeck -> Codex / VS Code continuity handoff

**Latest verified checkpoint:** 2026-11-26 Central. The internal pilot release serves the signed-in dashboard with incident history, shared in-app alerts, durable evidence and draft postmortems. The checkout SDK batch tuning is live. Section 5 records release checks, latency measurements, and rollback targets. Reverify live state before changing infrastructure.

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

GKE Cloud Audit Logs --(read-only lookup)--> deployed audit investigator
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
- `cloud-run-investigator/job.js`, `core.js`, `ai-analyst.js` — deployed audit-enrichment job and optional targeted Vertex analysis.
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
| M3 archive code | Live acceptance passed on November 25. One controlled GKE checkout failure persisted a matching investigation and trace evidence, and the signed-in dashboard displayed it | — |
| M3 Cloud SQL | Both archive tables are in use. The `signaldeck_reader` role successfully read the saved evidence and has no evidence INSERT grant | Replay deduplication and evidence retrieval after raw retention are covered in disposable PostgreSQL |
| M3 Cloud Run | `signaldeck-ingest-grounding-v1` serves 100% of ingest traffic. Collector trace and log POSTs returned HTTP 202 | Rollback revision is `signaldeck-ingest-00008-xil` |
| M3 feature flag | Active ingest `/ready` returned HTTP 200 with `archive_enabled:true` | — |
| Investigator | Audit write and replay passed against a controlled lab workload. Separate targeted runs saved evidence-backed findings for a downstream HTTP 500 and a checkout-local HTTP 500 | Audit-only by default. Additional evidence sources and failure modes need their own validation |
| Internal pilot | Live incident lifecycle and history, shared in-app alerts, evidence-linked Markdown drafts, and Central Time timestamps | External paging, managed production retention, and broader RCA coverage are separate release decisions |

The original release roadmap in `docs/product-roadmap.md` calls separate streams M0 (prototype), M1 (incident center), M2 (persistence), M3 (change correlation), M4 (tracing), M5 (Kubernetes), M6 (SRE assistant), M7 (notifications), M8 (scale). Those remain product-level milestones, not reliable implementation status. The working team has also called the **durable archive rollout** “Milestone 3”; use the specific feature name to avoid ambiguity.

## 4. Verified GitHub and rollout checkpoints

- Repository: `KalpeshDalvi/signaldeck`.
- PR #5 merged to `main` on 2026-11-18 as `f23415da6ccfd71f5044b891e0953bef0e4f7854`. GitHub Actions validation passed (Node, Next build and disposable PostgreSQL tests).
- [PR #8](https://github.com/KalpeshDalvi/signaldeck/pull/8) merged the deployed insert-only archive fix into `main` as `3e138bf`. Both PR jobs and [post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45747164567) passed. The Vercel deployment status reported an account block and was outside the branch's required checks.
- [PR #9](https://github.com/KalpeshDalvi/signaldeck/pull/9) tracks the deployed investigator code and the reviewed database grants. [Product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45749245031) passed.
- On November 26, [PR #13](https://github.com/KalpeshDalvi/signaldeck/pull/13) merged to `main` as `cec47f4`. [Post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45925539191) passed Node, PostgreSQL, and lab telemetry checks.
- GitHub issue #7 is the authoritative human rollout log: https://github.com/KalpeshDalvi/signaldeck/issues/7
- Existing direct GitHub WIF inventory workflow worked; do not replace it with PR #6 as a prerequisite.
- Cloud Run dashboard Saved Investigations page loaded the *successful empty list* state; direct Cloud Shell/proxy requests to read API `/healthz` returned GFE HTML HTTP 404, likely a different auth/access path. Do **not** make the read API public to silence that diagnostic. Source code confirms dashboard-to-read-API list uses a Cloud Run ID token + API key.
- Around 2026-11-18 18:13-18:14 Central, both UI and SQL query showed zero investigation rows. Section 5 records the successful live write after the fix.

## 5. Durable archive incident and verification

### November 25, 2026 archive checkpoint

- Live Cloud Run ingest `GET /ready` returned HTTP 200 with `archive_enabled:true`. Authenticated checks found `signaldeck-ingest-00007-zrs` serving 100% of ingest traffic, the running collector configured for that Cloud Run service, and recent trace POSTs returning HTTP 202. The dashboard's `/investigations` returned HTTP 302 to the unauthenticated probe.
- Cloud Logging on revision `signaldeck-ingest-00007-zrs` confirmed `permission denied for table investigation_evidence` alongside `/v1/traces` HTTP 503s on November 18, 2026, around 18:13–18:17 Central. The trace batches reached the database write path. The collector points to Cloud Run despite the older URL in the repository manifest.
- Disposable PostgreSQL 16 reproduced HTTP 503 and SQLSTATE `42501` on `public.investigation_evidence` after readiness returned HTTP 200. The evidence insert named conflict columns, which PostgreSQL requires `SELECT` to use. The documented ingest grant on the evidence table is `INSERT` only. The failed write rolls back raw telemetry in the same transaction.
- The local fix in `cloud-run-ingest/investigation-archive.js` uses `ON CONFLICT DO NOTHING`. The existing unique source key still deduplicates evidence while the ingest role stays insert-only. The PostgreSQL test now sends OTLP through the ingest HTTP service with the restricted role. It verifies evidence IDs and timestamps, replay deduplication, the healthy control, read API isolation, and evidence retrieval after raw telemetry removal. Archive unit tests and the dashboard build passed.
- The approved ingest-only rollout staged `signaldeck-ingest-00008-xil` at zero traffic. Candidate readiness passed and its runtime settings matched the previous revision. The new revision moved to 100% traffic and the temporary staging tag was removed. Rollback can move traffic to `signaldeck-ingest-00007-zrs`.
- On November 25 at 20:47:23 Central, one lab checkout deliberately returned HTTP 500. Cloud SQL contained raw trace `16526da1586c7a65b00d64ed0308eb56`, span `9321b687302ca4d1`, and investigation `3d70c1ec-9353-4f86-a995-06b60f13b447` linked to evidence `2244d313-8fed-470b-bd33-8491b62e00ba`. Evidence captured at 20:47:26 Central with source event ID `ca1510d0bc335fac3245d8cecf174a07e7134540e2bf4078a1e0b5251e8cdbfd`. The row records an observed failure and explicit causal limitations.
- In the same read-only check a subsequent checkout returned 200 and had zero matching evidence records. Cloud Logging showed post-test trace POSTs with HTTP 202 on revision `signaldeck-ingest-00008-xil` and no matching server errors in the verification window.
- The operator's signed-in screenshot showed one saved source record for `POST /checkout (500)`, with the same source, trace, and span IDs and the same observation and capture times. The page displayed the causal limitations. Cloud Logging recorded HTTP 200 from both the dashboard and read API for this investigation. [Saved investigation](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/3d70c1ec-9353-4f86-a995-06b60f13b447)
- The archive acceptance gate passed. The optional Vertex AI analysis remains disabled.

### Deterministic investigator validation

- Read-only Cloud Logging queries verified the October 22 lab inventory scale to zero and restore to one replica. The ten-minute window centered on the November 25 checkout returned zero matching GKE scale audit records. Cloud SQL still showed no initiating change, actor, or verified cause for that checkout.
- Ran `cloud-run-investigator/job.js` with restricted grants on disposable PostgreSQL 16 and a stubbed Logging endpoint serving the two historical audit records. The fixture used a test actor identity and shifted the timestamps together into the job's 24-hour candidate window. The matching workload was enriched, both original audit IDs were preserved, and the restore was recorded. The unmatched workload, checkout, and other workspace kept their original findings. A second execution added zero audit records. The 11 investigator tests passed and the job made zero Vertex AI calls.
- The historical zero-replica snapshot used for the positive database case was a fixture, consistent with the expired raw telemetry described above.

### Approved investigator setup

- Created the dedicated `signaldeck-investigator` service account. A view on `_Required` restricts GKE Admin Activity to the `signaldeck-lab` cluster. An operator query through the view returned both historical scale events, and the service account has `roles/logging.viewAccessor` on that view. Its Cloud SQL Client role is conditional on `signaldeck-db`.
- Local commit `aa415da` adds `SIGNALDECK_GCP_LOG_VIEW` and a manual `--check` that uses the configured view and archive database without writing findings. The grants and scoped read path passed with disposable PostgreSQL 16 and redacted audit fixtures. All 12 investigator unit tests passed.
- The operator applied `cloud-sql/migrations/004_investigator_runtime_grants.sql` in Cloud SQL Studio. A direct login verified the dedicated role's effective archive grants. The job uses a version-pinned credential in Secret Manager and is deployed from local commit `aa415da` with one task, zero retries, and `SIGNALDECK_AI_ENABLED=false`.
- The approved manual check completed on November 25 at 21:23 Central. Cloud Run recorded one successful task. From the deployed runtime identity, the check read the live archive and returned both expected GKE audit records, including the successful scale-to-zero request before the selected incident time. There were zero eligible archived workloads during the check. This execution exercised read access. The finding write path was exercised in disposable PostgreSQL. [Cloud Run execution](https://console.cloud.google.com/run/jobs/executions/details/us-central1/signaldeck-investigator-fzrwp?project=signaldeck-lab-kd)
- Live write-test preflight found zero eligible archived Kubernetes candidates. The operator approved one disposable GKE Deployment. The initial scale update omitted the requested replica count in its audit record. The same fixture was reset to one replica, then patched to zero in the next archive time bucket. This produced a successful scale-patch audit record with an explicit replica count before the second zero-replica snapshot.
- The November 25 live write (`signaldeck-investigator-mq9jf`) saved the matching audit source ID `07b125c0-5b1b-4337-9f42-68fe2eea04a1` on investigation `87dbb103-dfc2-4b55-b208-b2701f1a0c48`. The finding attributed the verified Kubernetes action and kept application causation unverified. The initial inconclusive fixture investigation and the separate checkout both kept their initiating change and actor unset. [Saved finding](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/87dbb103-dfc2-4b55-b208-b2701f1a0c48)
- The live replay (`signaldeck-investigator-ncgsf`) revisited the inconclusive fixture and preserved all audit source and evidence row IDs, with three audit records per fixture investigation. Both executions reported zero AI findings. The fixture and its Kubernetes dependents were removed. Checkout, inventory, and the traffic generator matched their baseline ready replica counts. Cloud SQL still returned the same archive records afterward.

### Incidents dashboard pilot change

- The local `feature/incidents-saved-investigations` branch adds six recent saved investigations to `/incidents`. Each row links to its evidence and the panel links to the complete archive. The live detector and archived findings retain their own labels.
- The archive request starts alongside the live request and streams behind its own loading state. The two reads share one Cloud Run identity-token lookup per server render. The live metrics reuse their filtered traces, and service grouping appends to existing arrays. In a local 500-trace benchmark, 1,000 service summaries took a median of 189 ms versus 354 ms before the grouping change, with identical output.
- Production build and browser checks passed with the read API backed by disposable PostgreSQL. Checks covered the delayed archive, evidence and archive links, workspace isolation, empty and unavailable responses, and mobile sizing. The 390 px viewport fit the whole page after fixing the mobile grid track. The standalone package passed the same checks.
- The approved dashboard-only rollout staged commit `83e68f2` at zero traffic and compared the runtime configuration, IAM policy, and IAP routing to the baseline. Revision `signaldeck-dashboard-00019-xav` serves 100% traffic with IAP sign-in. The operator confirmed the new section in the signed-in dashboard. Cloud Run recorded HTTP 200 for `/incidents` and the six-record archive query. Rollback target is `signaldeck-dashboard-00018-lh2`.

### Incident lifecycle persistence

- The local `feature/durable-incident-lifecycle` branch adds Cloud SQL storage for the existing Incidents controls. It uses a separate `signaldeck_incident_writer` login on `public.incidents`. Reads and writes use the configured workspace. Deployments without incident database settings retain their Supabase or in-memory storage.
- Incidents uses one indexed lookup for the batch of active candidates. A stable batch makes no writes. Changed batches recheck within a short transaction and write only new or changed rows. The note endpoint appends in one SQL update so parallel notes survive. A resolved record remains persisted by ID. Continued active symptoms can still open a new incident.
- Verified in disposable PostgreSQL 16 and the standalone dashboard. From the Incidents UI, an operator assigned an owner, changed the status to mitigated, and added a timeline note. The same incident ID, owner, status, and note ID were present in the database and visible after restarting the dashboard process. The saved-investigation link still showed preserved evidence. The page and API routes reused one idle PostgreSQL connection over a Unix socket. Integration tests also passed for workspace isolation, restricted role grants, concurrent note and incident creation, and transaction rollback. TypeScript, production build, OTLP archive integration and investigator unit tests passed. Dependency installation followed CI's `npm install` because the repository has no lockfile.
- Read-only live preflight on November 25 confirmed `signaldeck-dashboard-00019-xav` still serves 100% of dashboard traffic with IAP. The dashboard has no Cloud SQL attachment or lifecycle database configuration. Its runtime identity has no direct Cloud SQL Client project binding. The Cloud SQL instance is runnable on PostgreSQL 16.
- Live release requires approval to apply `cloud-sql/migrations/005_incident_lifecycle_runtime_grants.sql`, provision the writer credential in Secret Manager, and give the dashboard runtime identity access limited to the incident writer secret and the SignalDeck database instance. Configure the candidate with `SIGNALDECK_INCIDENT_DB_HOST=/cloudsql/<instance-connection-name>`, `SIGNALDECK_INCIDENT_DB_NAME=signaldeck`, and a version-pinned secret for `SIGNALDECK_INCIDENT_DB_PASSWORD`. The port defaults to 5432. Stage the revision at zero traffic, verify its IAP path and database access, and verify the lifecycle controls using a controlled incident before cutover. The predecessor revision is the traffic rollback target.
- The operator approved the lifecycle rollout on November 25. [Regional Cloud Build](https://console.cloud.google.com/cloud-build/builds;region=us-central1/44a2f319-3d24-443f-8050-6231ae340457?project=signaldeck-lab-kd) produced dashboard image digest `sha256:b5749ff44c0fbb23ccb3be2d6974edc763f5756fade3b8c6dd82bdc8707b7315`. Live catalog verification as `signaldeck_reader` confirmed the writer role was pending. The operator was asked to apply 005 through Cloud SQL Studio as `postgres`. The database verifier and dedicated credential provisioning helper are in `/private/tmp/signaldeck-archive-verification`. Dashboard traffic still points to `signaldeck-dashboard-00019-xav`. The IAP policy has human access and zero programmatic OAuth clients. The signed-in browser is needed for candidate UI verification.
- The operator applied 005. A live catalog query confirmed the dedicated login and exact insert and update columns. The writer credentials passed a Cloud SQL Auth Proxy login. The credential is pinned to Secret Manager version 1. The dashboard runtime has Cloud SQL Client access conditioned on the SignalDeck instance and access to its dedicated writer secret.
- Cloud Run reports `signaldeck-dashboard-lifecycle-v1` healthy at zero traffic. IAP, service invoker IAM, existing environment settings and traffic to `signaldeck-dashboard-00019-xav` matched the baseline. The [candidate Incidents route](https://lifecycle-check---signaldeck-dashboard-4xugrlc6la-uc.a.run.app/incidents) redirects unauthenticated traffic to sign-in.
- One synthetic lab trace for `signaldeck-lifecycle-check-cad9317e` returned OTLP HTTP 202. Cloud SQL recorded the HTTP 200 trace at approximately 1.9 s and zero archived investigations for that service. On November 25 around 23:35 Central the signed-in candidate dashboard rendered Incidents, created fixture incident `4e51a9b5-f3de-49ea-854f-bdc0b91b7aeb`, and returned HTTP 200 for the status change and two note writes. Cloud SQL confirmed `mitigated` and both notes. The owner field was blank after the operator check. The compiled dashboard API was run on loopback with the dedicated writer login against the same Cloud SQL database. Its owner-only PATCH returned HTTP 200 and preserved both note IDs and the mitigation timestamp.
- Around 23:39 Central, Cloud Run moved 100% of dashboard traffic to `signaldeck-dashboard-lifecycle-v1` and removed the preview tag. Readiness, the IAP sign-in redirect and baseline service IAM matched expectations. The fixture still had its owner, mitigated status and both notes in Cloud SQL after cutover. The error query returned zero matching revision errors during the verification window. Traffic rollback target is `signaldeck-dashboard-00019-xav`. [Issue #7 rollout update](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7183691054)

### Consolidated internal pilot

- [Draft PR #10](https://github.com/KalpeshDalvi/signaldeck/pull/10) brings together the scoped investigator from PR #9, the deployed dashboard lifecycle and archive UI, and new Incident history and detail pages. The history shows the latest 30 records by last update and loads only its summary fields when opened. Details preserve the operator controls after the source telemetry leaves the active view.
- Verified locally with the production dashboard build, disposable PostgreSQL 16, the ingest and read services, and the investigator. A browser test followed one failed OTLP checkout span to its original archived trace ID. Owner, mitigation status and a responder note remained accessible through incident history after a dashboard restart and raw telemetry removal. An incident from another workspace returned 404. The investigator replay preserved audit IDs and added no evidence. The [GitHub product-validation run](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45892153691) passed both jobs for the PR head. The Vercel preview status reports an account block.
- Read-only live checks on November 26 saw the dashboard, ingest, read API and investigator ready. The latest investigator execution succeeded, and Vertex AI is disabled. The pilot uses the existing manual investigator. Earlier live checks verified the archive, investigator, and lifecycle database grants. For the combined release, verify those grants and the runtime again, merge the reviewed PR, and stage the new dashboard image for a signed-in smoke test. The current dashboard revision is the cutover rollback target. The pilot merge and dashboard cutover await explicit approval.
- The operator approved the combined pilot release on November 26. Live checks confirmed the scoped investigator and lifecycle grants, the existing mitigated lab incident with its owner and two notes, and ingest readiness with archive capture enabled. PR #10 merged as `64ee26c` with a tree identical to the tested PR head. [Post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45907109628) passed.
- [Cloud Build](https://console.cloud.google.com/cloud-build/builds;region=us-central1/4cc6bd05-f75e-4d78-90fc-4602b8a82d42?project=signaldeck-lab-kd) produced the image for `signaldeck-dashboard-pilot-v1`. The revision passed readiness and is staged at zero traffic. The runtime settings, IAP, and invoker IAM compared equal to the baseline apart from the image. The [preview](https://pilot-preview---signaldeck-dashboard-4xugrlc6la-uc.a.run.app/incidents/history) redirects unauthenticated requests to sign-in. Cutover is pending the signed-in history, incident detail, and archived evidence smoke test. `signaldeck-dashboard-lifecycle-v1` is serving 100% and is the rollback target.
- The signed-in preview returned HTTP 200 for history, the persisted incident detail, and the saved checkout investigation. The read API returned HTTP 200 for the corresponding archived evidence. The operator asked for Central Time before cutover. [PR #11](https://github.com/KalpeshDalvi/signaldeck/pull/11) updated the archive list, observed time and captured time to the existing Chicago formatter. Unit tests covered CST, CDT and the repeated fall-back hour. A browser running against a UTC-hosted standalone build verified the Central labels and the original ISO time attributes. The full pilot browser test and [post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45908629461) passed.
- Around 17:05 Central on November 26, `signaldeck-dashboard-pilot-central-v1` moved from zero traffic to 100% in one production cutover. The image was built from the same source tree merged as `169dbf6`. Readiness, IAP, invoker IAM and both canonical route sign-in redirects passed. No candidate revision errors appeared in the verification window. The temporary preview tag was removed. Traffic rollback target remains `signaldeck-dashboard-lifecycle-v1`. [Issue #7 pilot release](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7205245878)

### AI investigator trial

- Reproduced a privacy gap with synthetic values. The optional model packet forwarded summaries, excerpts, and nested values in numeric fields. [Draft PR #12](https://github.com/KalpeshDalvi/signaldeck/pull/12) limits the packet to bounded application facts and uses temporary service, trace, span and evidence references. Accepted citations resolve back to the complete original source IDs. The saved model text is labeled as a hypothesis with a possible mechanism.
- The new `npm --prefix cloud-run-investigator run trial:ai` command generates one model request from its bundled synthetic traces. It has no Cloud SQL connection. The mocked CLI run sent exactly one request. A disposable PostgreSQL 16 run through the investigator job rejected an invented citation without a write, proved the two-analysis cap, preserved original citations and workspace scope, and passed deterministic audit replay. Syntax, unit checks and dashboard build passed.
- The deployed investigator is healthy and has AI disabled. The read-only service check found the Vertex AI API disabled. The next separate approval covers enabling that API and running a single synthetic request in the US multi-region endpoint. The provider trial will test whether Gemini 3.1 Flash-Lite can describe the observed dependency failure and keep the initiating condition uncertain. Provider behavior and output quality remain unverified.
- Both [GitHub product validation jobs](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45911527137) passed on the trial PR head `459ed80`.
- After the operator approved one synthetic trial, the Vertex AI API was enabled and the caller's prediction permission was verified. One Gemini 3.1 Flash-Lite request in the US multi-region returned HTTP 200 with both original fixture citations and 803 tokens of reported usage. The fixture had an HTTP 500 checkout parent span and an HTTP 503 inventory child span in the same trace. The model identified the failing dependency and said the cause of the 503 remained unknown. Its explanation also inferred checkout's error-handling behavior, which needs application evidence. The model test had no Cloud SQL connection, and the deployed investigator's AI flag was still false after the check. [Issue #7 trial result](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7205780970)
- The requested GKE egress trial sent one separate synthetic evidence packet and returned HTTP 200. Its failed probe left the node with Pod source `10.52.4.17`, which the destination firewall denied. The firewall allowed the primary node subnet `10.10.0.0/24`, and a control from `10.10.0.14` succeeded. The fixture showed default SNAT disabled, the IP masquerade agent absent, and no matching NAT rule. Gemini cited this evidence and correctly explained the source CIDR mismatch. Its remediation suggested permitting the Pod CIDR or using Cloud NAT, despite the fixture requiring the node subnet as the source. A policy-aligned proposal would restore destination-specific GKE masquerading and verify the observed node source and successful connection. This trial supplied packet, firewall and NAT facts directly to the trial harness. The optional application investigator currently selects traces and application logs. The fixture and result are in `/private/tmp/signaldeck-synthetic-egress-ai.2SNGHy`.
- The operator deferred GKE egress evidence collection and approved one synthetic checkout grounding trial. One Gemini request returned HTTP 200 and passed both case checks. In the trace-only case, checkout HTTP 500 and inventory HTTP 503 were cited separately and checkout's response handling remained unknown. In the second case, the model cited the structured application log for the observed mapping from inventory's 503 to checkout's 500. The cause of the inventory 503 remained unknown in both cases. The trial validator rejected a cross-case citation and a trace-only handling claim in local checks. The trial used a separate structured schema and fixture in `/private/tmp/signaldeck-checkout-grounding.9EFU2T`. The next product task is to enforce equivalent claim-level citations and accept an allowlisted structured response-handling event in PR #12.
- PR #12 head `b109eb5` implements the claim-level save gate. Ingest accepts a structured response-mapping event with two validated HTTP codes. The investigator requires the log and matching server and direct dependency spans on the same trace within an archived investigation, checks timing and HTTP codes, and renders each saved observation with its source IDs. The model makes labeled recovery and prevention proposals. A disposable PostgreSQL 16 lab exercised OTLP ingestion, investigation with a mocked provider, and read-back for both checkout cases. Unsupported evidence types left the investigation unchanged. The log-backed case cited the log and both spans. The tests also covered replay, workspace isolation, the audit investigator, and the dashboard build. A Cloud Run rollout and live controlled case require approval for the ingest plus investigator changes.
- Both [GitHub product-validation jobs](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45914909589) passed on `b109eb5`.
- The operator approved the grounding rollout and a five-hour authorization window on November 26. PR #12 added an explicit `--analyze-incident <uuid>` execution mode and tests for targeting only the selected eligible investigation in the configured workspace. It merged as `648334a`. [Post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45916547324) passed.
- Staged `signaldeck-ingest-grounding-v1` at zero traffic with the existing SQL and authenticator settings. The manual investigator was updated to the image digest ending in `6cfca4c376bd5b9caf4990c28d481dcb135a14a5d44ee114eafa6ca9ecb1710a`. Its deterministic audit check succeeded against the existing scoped view and matched both historical scale audit records. The previous job image digest ends in `a9b7377bc00c0e2b5fafb26e0408ed6ffe61a1eebd78f8db25463b7cc6848c02`.
- Staged OTLP accepted two spans and one structured log for a single synthetic checkout case. The new investigator ran with one task, zero retries, the exact investigation ID, and execution-only model settings. Its [targeted execution](https://console.cloud.google.com/run/jobs/executions/details/us-central1/signaldeck-investigator-m7x92?project=signaldeck-lab-kd) completed with one finding. Cloud SQL confirmed that the saved 503-to-500 mapping cites the original log and both spans. The verified mechanism and initiating change are unset and the dependency response cause remains unknown. [Lab investigation](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/1e98be01-ef4c-4882-932b-9e3350fd79ce)
- The temporary binding for the investigator's single-permission Vertex role was removed and verified absent. The custom role definition remains available without the binding. The investigator's default remains audit-only. Ingest cut over to 100% on `signaldeck-ingest-grounding-v1`. Canonical readiness and normal collector trace POSTs passed, and the post-cutover check found zero HTTP 5xx. The preview tag was removed. Rollback target is `signaldeck-ingest-00008-xil`. [Issue #7 rollout update](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7206532931)

### Live checkout application evidence

- PR #13 instrumented a structured checkout error when the application maps an inventory HTTP 5xx response to checkout HTTP 500. A local production-style Gunicorn run sent the log and both spans over OTLP/gRPC. GKE checkout revision 3 rolled out with two ready replicas on image digest `sha256:bb98d29b5b00f07d3458e8c7b00a377b656bdcb5c02c4918f0561f5a706249d3`. Revision 2 is the rollback checkpoint. Inventory's deployment spec matched the pre-rollout snapshot and the collector stayed ready.
- One controlled inventory-error request at 8:00 p.m. CST entered the archive through the live collector. Cloud SQL returned exactly three related records with one trace ID. Checkout's server span and its direct inventory client span both recorded HTTP 500. The structured log linked those observations to checkout's response handling.
- [One targeted execution](https://console.cloud.google.com/run/jobs/executions/details/us-central1/signaldeck-investigator-m5x9p?project=signaldeck-lab-kd) completed with one finding. Cloud SQL, the authenticated read API, and signed-in Safari confirmed the saved mapping and its three original source IDs. Safari showed the evidence timestamps in CST. The verified mechanism and initiating change fields remain unset because the cause of the inventory error is unknown. [Saved lab investigation](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/5ed98665-3431-4fd8-b0c8-7ed509c46b15)
- The execution-only Vertex permission was removed and verified absent. The investigator defaults to audit-only. [Issue #7 checkout verification](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7207815466)

### Pilot latency baseline and controls

- Across four archived records from two controlled GKE checkout failures, the time from OTLP observation to archive capture was 2.55–8.86 seconds. This includes SDK and collector batching. The earlier synthetic fixture used backdated observations and was excluded from these timings.
- In a 24-hour Cloud Run request sample, the live read API median was 14.7 ms for the investigation list (34 requests) and 36.1 ms for details (11 requests). The signed-in dashboard detail median was 25.4 ms and its slowest request was 4.07 seconds (8 requests). All eight list/detail requests above one second across the dashboard and read API matched a new instance's startup within 15 seconds. These are pilot samples. The sampled live PostgreSQL queries used indexes and executed in less than 0.3 ms.
- At the baseline, the checkout SDK and live collector each used a five-second batch interval. In a local Gunicorn and OTLP receiver trial with ten requests per setting, reducing the SDK interval to one second moved median time until all three records reached the receiver from 2.84 s to 0.56 s and increased exports from two to seven per signal. This tested SDK export only. The deployed batch and scaling settings were unchanged.
- A single checkout-local HTTP 500 saved one server span. A separate request with three seconds of injected inventory latency returned HTTP 200. All three successful spans reached raw telemetry and no evidence from that trace was archived. The authenticated read API also returned the prior workload finding with its original successful scale-to-zero audit source ID. [GKE workload investigation](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/87dbb103-dfc2-4b55-b208-b2701f1a0c48)
- [One targeted run](https://console.cloud.google.com/run/jobs/executions/details/us-central1/signaldeck-investigator-l9p8t?project=signaldeck-lab-kd) saved the checkout-local HTTP 500 with its single original span citation. API read-back and signed-in Safari confirmed the finding, evidence timeline, and CST timestamp. The root cause is still unverified. The temporary Vertex permission was removed and verified absent. [Checkout-local investigation](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/14887f72-e6e8-485c-b6ff-0aaebeb1e600) · [Issue #7 pilot acceptance](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7207959553)

### Completed internal pilot release

- [PR #15](https://github.com/KalpeshDalvi/signaldeck/pull/15) merged as `7bd3171`. It adds an IAP-protected Alerts inbox with one row per saved investigation, shared acknowledgement, and links to preserved evidence. Saved investigations now offer an evidence-cited Markdown draft with Central Time timestamps. [Post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45929465333) passed.
- Cloud SQL backup `1795746922604` completed successfully before migration 006. The Cloud SQL managed import applied the additive receipt schema to the `signaldeck` database. Temporary read access to the single private staging object was removed and verified. The dashboard writer can select and insert receipts and cannot update or delete them.
- A production-build browser test covered a fresh OTLP failure, an acknowledgement click, replay, a dashboard restart, raw fixture telemetry removal, and a draft download. Cross-workspace draft access returned 404. The live restricted database role wrote the checkout test receipt twice with a stable timestamp. The IAP-signed-in preview and canonical dashboard rendered the same acknowledgement, the evidence timeline, and the postmortem link. The signed-in Markdown request returned HTTP 200. [Alerts](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/alerts)
- `signaldeck-dashboard-pilot-alerts-v1` serves all traffic. The runtime settings and invoker IAM matched the baseline apart from the container image. The preview tag was removed after the signed-in checks. Rollback target is `signaldeck-dashboard-pilot-central-v1`.
- [PR #16](https://github.com/KalpeshDalvi/signaldeck/pull/16) merged as `72918c3`. With 48 total requests and 12 controlled failures per setting through the live Collector version, the one-second checkout SDK interval lowered median delivery of complete failure evidence from 6.50 s to 3.13 s. The collector stayed at five seconds during the comparison. Both runs preserved all expected records, with three trace exports each and log exports increasing from two to three. [Post-merge product validation](https://github.com/KalpeshDalvi/signaldeck/actions/runs/45929852887) passed.
- Checkout revision 4 has two ready replicas, with both SDK intervals set to one second. The inventory spec matched its baseline. A single controlled dependency error archived all three expected records in 3.11–4.35 seconds and raised one new alert. Rollback target is checkout revision 3. [Post-rollout case](https://signaldeck-dashboard-4xugrlc6la-uc.a.run.app/investigations/e63c580d-a1df-47c3-838a-82d43d09550a)
- Under the observed resource limits, keeping one dashboard and one read API instance idle for 30 days is approximately USD 22.68 before credits and active requests. The pilot keeps scale to zero. [Cloud Run pricing](https://cloud.google.com/run/pricing)
- The seven-day cleanup procedure removed aged raw fixtures and preserved the evidence in disposable PostgreSQL. The live database has the procedure, some older observations, and no installed `pg_cron`. Automatic deletion requires an approved operating schedule and retention policy. [Issue #7 pilot release](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7208411893)

**Diagnostic sequence for future archive failures**

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

## MVP acceptance audit · November 27, 2026 Central

The prior internal pilot release proved the archive, in-app alerts, and isolated parts of incident response. This audit applies the original MVP gates to the complete workflow. Approval is required for migration 007, merging the candidate, deploying the dashboard, and any disruptive or mutating live drill. Keep Vertex AI disabled and external paging gated on pilot acceptance.

| Acceptance gate | Implemented in candidate | CI coverage | Current deployment and runtime evidence | Pilot acceptance needed |
|---|---|---|---|---|
| 1. Durable lifecycle | Resolution suppresses stale telemetry replay. A later failure can create a new incident. Owner, notes, mitigation and resolution persist | Restricted PostgreSQL tests cover replay, reopen, later failure and parallel notes | Existing Cloud SQL lifecycle is deployed. Historical live ownership and mitigation do not cover the replay fix | Confirm a resolved record after a process restart and redisplay of the original failure |
| 2. Unified Incidents and Saved Investigations | Responders explicitly link a saved investigation for the same service and environment. Both detail pages navigate to the other | Migration retry, conflict handling, workspace foreign keys and restricted role tested | Existing pages are live. Migration 007 and candidate dashboard are pending approval | Verify links and the controlled incident across authenticated pages |
| 3. Evidence-grounded correlation | Existing trace and GKE audit paths remain. Candidate rejects cross-environment evidence and null replica counts in workload correlation | Original trace/audit suites and new mixed-scope regression | Read-only checks returned the archived workload audit ID. Earlier live checkout evidence independently corroborated the dependency response. The cases do not establish an application-to-audit causal chain | Review the evidence boundaries in one controlled workflow. Keep initiating cause unset without corroboration |
| 4. Recovery and validation | Deterministic advice cites archived failures. A matching successful server span on the same operation after mitigation can be saved as a durable check with both original IDs | Probe constraints, concurrent replay and persisted result tested | Prior guidance is deployed. Recording the check is a candidate feature | Capture a successful same-operation probe and verify the record after resolution |
| 5. Complete end-to-end scenario | Disposable browser run covered failed OTLP, archive, linking, ownership, mitigation, successful probe, resolution and raw telemetry removal | Component and data-path regression checks in CI. Full disposable browser scenario run separately | Existing live release proved evidence capture, but no single signed-off run covers the complete candidate workflow | Run and accept the full scenario on an approved lab revision |
| 6. Authentication, workspace isolation and retention | Existing IAP and fixed-workspace read paths. Candidate preserves both and requires JSON for lifecycle API writes | Restricted PostgreSQL roles, cross-workspace links and downloads, and raw cleanup preserving saved evidence | Dashboard IAP denied an unauthenticated request. The archived audit and app records read back through the private API. The cleanup procedure exists. No live cleanup schedule was verified | Confirm reader and responder scopes in the approved pilot and sign off the retention window and evidence preservation |

For the live drill, stage the candidate dashboard behind the existing IAP and leave canonical traffic on its baseline. Check the restricted role and database backup before any approved migration. Use one controlled checkout failure and one successful request for the same operation. Read a single saved investigation, link it from Incident history, add an owner and note, mark mitigated, record the successful trace, resolve, and reopen the view after a restart. Preserve the failure source ID, recovery telemetry ID, original incident ID and Central timestamps. Verify that a different workspace cannot read or link either record. Record which steps were observed, and roll back dashboard traffic to the pretrial revision if any gate fails.

### Approved live MVP checkpoint · November 27, 2026 Central

- PR #18 merged as `e941614` and passed all three post-merge validation jobs. Cloud SQL backup `1795840099031` completed before shared migration 007. The migration landed and temporary read access to the migration object was removed. The writer read and inserted scoped links and had no link UPDATE or DELETE grants.
- `signaldeck-dashboard-mvp-drill-v1` is staged at zero canonical traffic. `signaldeck-dashboard-pilot-alerts-v1` still serves 100%. Existing IAP and invoker IAM match the baseline. Vertex AI is disabled.
- One approved GKE checkout request returned HTTP 500 and its three evidence records arrived within 3.71 seconds. The same runtime persistence code created the controlled response record, linked its archive, assigned an owner and added a note. After mitigation, one normal request returned HTTP 200. The validated recovery saved the original failure and recovery IDs. A fresh connection read back the resolved row and stale replay required no write.
- Signed-in staging displayed the history, original evidence, both links, recorded recovery, resolution, and CST timestamps. The initiating change remained unknown. Hosted form submission still needs confirmation. The disposable browser run exercised the actual forms and dashboard restarts. Retention and operator sign-off remain open before paging. [Issue #7 drill proof and checklist](https://github.com/KalpeshDalvi/signaldeck/issues/7#issuecomment-7234135879)

### Retention and hosted acceptance · November 28, 2026 Central

- A read-only probe confirmed that `cleanup_old_telemetry` uses ingestion time (`created_at`) and applies across the raw telemetry table. The table was estimated at 1.8 million rows and has no workspace plus ingestion-time index. Three 0.25% page samples found seven-day eligibility in 6.7%, 7.3%, and 8.6% of sampled pilot rows. The samples are a workload estimate. The full-count query did not complete under the bounded probe.
- The live reader has no raw DELETE grant. None of the incident, archive, evidence, link, or acknowledgement tables has a foreign key referencing raw telemetry. The live instance has no `pg_cron`, and the Cloud Scheduler API is disabled. These checks leave external scheduling unverified.
- Proposed migrations 008 and 009 add a concurrent workspace/ingestion-time index and an invoker-rights cleanup function. The function requires an explicit workspace, caps deletions at 5,000 per call, and returns the actual rows removed. It uses `created_at`, preserves current rows and other workspaces, and grants no runtime access. The disposable PostgreSQL test proved bounded cleanup, scope, permission denial for the reader, and archived evidence read-back. These migrations are pending separate approval.
- On a disposable 100,000-row fixture, the ordered 1,000-row selection used a sequential scan and sort before the new index. After indexing it used an index scan. Measured selection time was 16.0 ms before and 0.59 ms after. Compare the live plan before an approved rollout.
- Before an approved cleanup test, verify the account, database, backup, eligible scope and index validity. Apply 008 outside a transaction and check `pg_index.indisvalid` before using 009. Start with one small batch in the approved workspace and compare retained archive and lifecycle records. Record each batch result separately. Pause further batches or a future schedule if checks fail. Reversibility for deleted raw rows depends on database backups.
- The staged candidate still has zero canonical traffic. Signed-in reads displayed the resolved incident and both evidence links. Existing IAP settings contain zero allowlisted programmatic clients, and no authenticated browser automation is available for the hosted write check. An authorized responder can add one test note to the [staged drill incident](https://mvp-drill---signaldeck-dashboard-4xugrlc6la-uc.a.run.app/incidents/681f3e1d-12fe-42c4-8f9c-c081980f95e4), refresh, and confirm the note appears once while the record stays resolved. Record the evidence and obtain separate approval for traffic promotion. The canonical rollback target is `signaldeck-dashboard-pilot-alerts-v1`.

## 6. Acceptance criteria and work after the immediate blocker

**M3 durable archive acceptance:**
- A newly ingested, authentic failed lab span creates a persistent investigation and at least one immutable evidence record.
- Source ID, original event timestamp, source type, observation/capture timestamps and reasoned limitation are visible.
- Read API and dashboard show it; raw telemetry is not required to display the archived evidence.
- Replaying event does not duplicate evidence; healthy signal is not archived as a failure.
- Workspaces are isolated; read-only API never gains writer permission.
- Write errors are explicit and collector retries are observable; do not misrepresent missing data as a healthy system.

**Beyond the internal pilot**
1. Select production paging destinations, escalation policies, and recipient scopes.
2. Approve an automated retention schedule and pilot service budgets before expanding access.
3. Extend causal validation to additional failure mechanisms and evaluate workspace membership and role isolation before multi-tenant use. The operator deferred GKE egress and IP masquerading.

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

> Read AGENTS.md, this handoff, docs/product-architecture-and-release.md, docs/milestone-3-deployment.md, docs/product-roadmap.md, and GitHub issue #7. Inspect the current main branch, CI, and runtime using read-only checks. The prior internal pilot release is live. Use the MVP acceptance audit and issue #7 to complete the remaining approved lab gates before external paging. Keep the evidence and uncertainty visible, and update issue #7 and this handoff after validation.
