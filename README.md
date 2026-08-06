# SignalDeck

OpenTelemetry-native observability dashboard for GCP and GKE environments.

## Current milestone

The repository contains the first runnable Next.js dashboard with:

- Production health overview
- Service golden signals
- GKE cluster capacity
- Incident activity
- Distributed trace visualization
- Health-check API

The current data is simulated. Real OpenTelemetry ingestion, authentication, persistence, and GCP onboarding will be added incrementally.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Health endpoint:

```text
http://localhost:3000/api/health
```

## Production build

```bash
npm run build
npm start
```

## Roadmap

1. Application shell and mock observability experience
2. Persistent workspace and user authentication
3. OTLP ingestion gateway and OpenTelemetry Collector configuration
4. GKE inventory, metrics, logs, traces, and events
5. Alert rules and incident investigation
6. Multi-tenant SaaS controls and usage metering
