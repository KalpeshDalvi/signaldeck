# SignalDeck Product Roadmap

## Product position

SignalDeck is an incident-response platform for Kubernetes and cloud-native systems. Observability data is the evidence layer; the primary user outcome is faster detection, investigation, mitigation, and resolution.

> Teams may continue using Prometheus, Grafana, OpenTelemetry, Cloud Logging, and other telemetry systems. When production breaks, they open SignalDeck.

## Core questions SignalDeck must answer

1. What changed?
2. What is broken?
3. Which service or dependency is responsible?
4. What evidence supports that conclusion?
5. What should the responder do next?
6. Did the action mitigate the incident?

## Product principles

- Incident-first, not dashboard-first.
- Evidence must be traceable to telemetry records.
- Findings must distinguish facts, correlations, and hypotheses.
- Suggested actions must never execute automatically without explicit authorization.
- One incident workspace should replace multi-tab investigation across logs, traces, metrics, Kubernetes, and deployments.
- OpenTelemetry remains the primary ingestion standard.

## Target architecture

```text
Applications / GKE / Cloud Run / VMs
                 |
                 v
      OpenTelemetry Collectors
                 |
                 v
        SignalDeck Ingestion API
                 |
          processing pipeline
                 |
       +---------+----------+
       |                    |
       v                    v
 Telemetry storage     Incident engine
 ClickHouse later      correlation/rules
 Supabase initially          |
       |                      v
       +------------> Investigation API
                              |
                              v
                        Next.js product
```

## Release milestones

### M0 — Working telemetry prototype — complete

- Next.js application
- Authenticated ingestion API
- OTLP/HTTP JSON endpoints
- Live services, traces, logs, and overview
- Dynamic service detail page
- Initial incident workspace

### M1 — Incident command center

Goal: make `/incidents` the primary product experience.

Deliverables:

- Incident identity and severity
- Lifecycle states: Detected, Investigating, Mitigated, Resolved
- Started time, duration, owner, and affected environment
- Correlated evidence timeline
- Affected services and dependencies
- Current finding and confidence level
- Fact versus hypothesis labeling
- Recommended investigation actions
- Manual notes and responder activity
- Explicit resolve and reopen actions

Release criteria:

- A responder can understand the incident without opening another SignalDeck page.
- Every finding links to supporting telemetry.
- Incident state persists across restarts.

### M2 — Persistent platform foundation

Goal: remove dependence on process memory.

Deliverables:

- Supabase-backed users, workspaces, environments, API keys, incidents, and responder notes
- Persistent telemetry for the development MVP
- Row-level workspace isolation
- Retention configuration
- Database migrations
- Seed data for local development

Release criteria:

- Restarting the application does not lose incidents or telemetry.
- Two workspaces cannot access each other's data.

### M3 — Deployment and change correlation

Goal: answer "what changed?"

Deliverables:

- Deployment events through OTLP and GitHub/GKE metadata
- Revision, image, commit, and actor tracking
- Timeline correlation between deployments and failures
- Before/after error-rate and latency comparison
- Change-risk evidence cards

Release criteria:

- SignalDeck can identify a deployment that preceded a regression and show the timing evidence.

### M4 — Real distributed-trace investigation

Goal: identify the failing or slow dependency.

Deliverables:

- Parent-child span model
- Trace waterfall
- Service and dependency graph
- Database, HTTP, queue, and cache dependency classification
- Common-path comparison across failed traces
- Bottleneck contribution analysis

Release criteria:

- Responders can determine where failed requests spend most of their time.

### M5 — Kubernetes incident evidence

Goal: connect application symptoms to workload health.

Deliverables:

- Cluster, namespace, deployment, pod, and container inventory
- Restarts, OOM kills, scheduling failures, and readiness failures
- Kubernetes events in incident timelines
- CPU and memory evidence around incident start
- Deployment-to-pod correlation

Release criteria:

- SignalDeck can determine whether a service incident coincides with workload instability.

### M6 — SRE investigation assistant

Goal: provide evidence-grounded assistance, not a generic chatbot.

Deliverables:

- "What changed?", "Why?", and "What should I do?" investigation prompts
- Evidence-cited findings
- Confidence score with explanation
- Alternative hypotheses
- Recommended checks and reversible actions
- Incident summary and postmortem draft

Guardrails:

- Never state an unsupported root cause as fact.
- Never perform remediation without explicit approval and authorization.
- Always show the evidence used for conclusions.

### M7 — Notifications and team response

- Slack notifications
- Email notifications
- Incident deep links
- Assignment and ownership
- Acknowledgement workflow
- Responder updates
- Status-page-ready summaries

### M8 — Scalable telemetry backend

- ClickHouse for logs and traces
- Time-bucketed metrics engine
- Sampling and cardinality controls
- Object-storage archival
- Multi-region ingestion design
- Usage and cost metering

## Immediate sprint backlog

### Sprint: Incident lifecycle and persistence

1. Add incident data model.
2. Add incident state transitions.
3. Add persistent incident store with memory fallback.
4. Create incident API endpoints.
5. Add started time, duration, owner, and severity.
6. Add manual investigation notes.
7. Label timeline entries as fact, correlation, or hypothesis.
8. Add Resolve and Reopen controls.
9. Link current findings to supporting traces and logs.
10. Add a repeatable telemetry fixture for testing incidents.

## Definition of done for each increment

- Committed to `main` after implementation.
- Runs with `npm run dev`.
- Has a documented test procedure.
- Includes an empty state and error state.
- Does not hardcode production-looking values when live telemetry should be used.
- Preserves workspace isolation assumptions.
- Distinguishes confirmed evidence from inferred conclusions.

## Near-term stack

- Frontend and API: Next.js + TypeScript
- Identity and product data: Supabase
- Initial telemetry persistence: Supabase PostgreSQL
- Collection and protocol: OpenTelemetry Collector + OTLP
- Deployment: Vercel for UI/API during MVP
- Long-term telemetry store: ClickHouse
- Cloud focus: GCP and GKE first
