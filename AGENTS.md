# SignalDeck coding-agent instructions

You are contributing to SignalDeck, an OpenTelemetry-native, incident-first SRE investigation platform. Our product goal is **verified causal analysis**, not merely flagging which service failed. Reconstruct symptoms -> failed dependency/mechanism -> initiating change or operation (where proven) -> recovery -> recurrence prevention -> validation, each backed by original evidence IDs and explicit uncertainty.

## Read context before making a plan or edits

1. `docs/CODEX_HANDOFF.md` — **current developer handoff, known live state, immediate blocker and acceptance criteria**. Start here.
2. `docs/product-architecture-and-release.md` — implemented/target architecture and safety constraints.
3. `docs/milestone-3-deployment.md` — technical archive/Cloud Run procedure (some older pending-state language may be stale).
4. `docs/product-roadmap.md` — **aspirational/historical roadmap**; references to Supabase/Vercel are not proof of the current GCP deployment.
5. GitHub issue #7 — durable rollout evidence and latest operator observations: https://github.com/KalpeshDalvi/signaldeck/issues/7
6. Inspect current code and GitHub CI; docs are not proof of live infrastructure state.

## Repository implementation

- Next.js 16 / TypeScript dashboard: `app/`, `components/`, `lib/`.
- Node.js Cloud Run `signaldeck-ingest`: `cloud-run-ingest/`; receives OTLP and optionally archives error evidence.
- Node.js Cloud Run `signaldeck-read-api`: `cloud-run-read-api/`; workspace-scoped, read-only PostgreSQL access.
- Node.js Cloud Run investigator job (NOT yet live-validated): `cloud-run-investigator/`, with optional disabled-by-default Vertex AI analyst.
- GKE incident lab / OTel collector: `incident-lab/`; Cloud SQL migrations: `cloud-sql/migrations/`.
- GCP: project `signaldeck-lab-kd`, region `us-central1`; Cloud SQL instance `signaldeck-db`.
- Live GCP resource state must be verified at execution time; NEVER assume repo manifest, README, or stale checkpoint equals production state.

## Safety and authority

- **No destructive operations**, infrastructure deletion, database shutdown, cluster deletion, bulk scaling, privilege expansion, merges or production deployment without explicit approval and preflight checks. Project may share resources with Spacical Interiors; preserve it.
- Existing direct GitHub Actions Workload Identity Federation works. Do not replace it with PR #6 unless concrete evidence requires it and approval is obtained.
- No secrets, tokens, passwords, service-account keys or other sensitive telemetry in source, logs, chat or commits. Preserve Cloud Run auth, existing IAM/secret references and least-privilege DB roles.
- Do not enable public unauthenticated access for a diagnostic 404. The dashboard successfully queried the private read API while direct Cloud Shell requests returned Google HTML 404; investigate access path before changing IAM.
- Use a lab-only controlled **single-request** failure first; do not scale `inventory` to zero to test archiving. Preserve service replicas.
- Never equate correlated events with verified RCA; root cause must be supported by application logs/traces, dependency evidence, Kubernetes state and/or audit-change facts. Record limitations.

## Working style, tests and delivery

- First inspect `git status`, `git log`, relevant source and tests. State what is VERIFIED, REPORTED, NOT VERIFIED. Keep a short plan and fix one evidenced blocker at a time.
- Review PR status and run locally: `npm ci`, `node --check cloud-run-ingest/server.js`, `node --check cloud-run-read-api/server.js`, `node --check cloud-run-investigator/job.js`, `node --test cloud-run-ingest/test/archive.test.mjs`, `npm run build`. Consult `.github/workflows/product-validation.yml` for the full PostgreSQL test matrix.
- Prefer safe read-only GCP commands before any proposed write. Require explicit permission for consequential actions; offer `--check`/dry-run first and a rollback.
- When fixing issues, add tests and evidence-based verification, ensure workspace isolation, preserve PII redaction and ID-based evidence citation.
- Document changes in GitHub issue #7 and update `docs/CODEX_HANDOFF.md` status after validation so the next Codex or ChatGPT session can resume accurately.
