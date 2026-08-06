const services = [
  { name: "billpay-api", status: "Healthy", requests: "4.8k/min", error: "0.4%", p95: "212 ms" },
  { name: "admin-portal-api", status: "Degraded", requests: "1.7k/min", error: "2.8%", p95: "924 ms" },
  { name: "client-service", status: "Critical", requests: "913/min", error: "6.2%", p95: "1.8 s" },
  { name: "notification-worker", status: "Healthy", requests: "604/min", error: "0.1%", p95: "96 ms" },
];

const events = [
  { time: "13:31", severity: "Critical", title: "Error rate above 5%", detail: "client-service · production" },
  { time: "13:27", severity: "Warning", title: "P95 latency regression", detail: "admin-portal-api · +61% after deployment" },
  { time: "13:22", severity: "Info", title: "Deployment completed", detail: "billpay-api · revision 7d91c" },
  { time: "13:15", severity: "Warning", title: "Pod restarted", detail: "client-service-6b87d9c4f9-rk2lp · OOMKilled" },
];

function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status.toLowerCase()}`}>{status}</span>;
}

export default function Home() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo">S</span><div><strong>SignalDeck</strong><small>GCP Observability</small></div></div>
        <nav>
          {['Overview', 'Services', 'Kubernetes', 'Traces', 'Logs', 'Alerts'].map((item, index) => (
            <a className={index === 0 ? 'active' : ''} href="#" key={item}>{item}</a>
          ))}
        </nav>
        <div className="workspace"><small>Workspace</small><strong>BillPay Platform</strong><span>Production</span></div>
      </aside>

      <section className="content">
        <header>
          <div><p className="eyebrow">PRODUCTION HEALTH</p><h1>Overview</h1><p className="muted">Live health across GKE workloads and application services.</p></div>
          <div className="header-actions"><button>Last 30 minutes</button><button className="primary">Connect GCP</button></div>
        </header>

        <div className="metrics">
          <article><span>Services</span><strong>42</strong><small>38 healthy</small></article>
          <article><span>Request rate</span><strong>8.2k</strong><small>per minute</small></article>
          <article><span>Error rate</span><strong>1.7%</strong><small className="bad">↑ 0.6%</small></article>
          <article><span>P95 latency</span><strong>842 ms</strong><small className="bad">↑ 18%</small></article>
          <article><span>Active alerts</span><strong>4</strong><small>1 critical</small></article>
        </div>

        <div className="grid">
          <article className="panel services">
            <div className="panel-title"><div><h2>Service health</h2><p>Golden signals across discovered services</p></div><button>View all</button></div>
            <div className="table">
              <div className="row heading"><span>Service</span><span>Status</span><span>Requests</span><span>Error rate</span><span>P95</span></div>
              {services.map((service) => <div className="row" key={service.name}><strong>{service.name}</strong><StatusPill status={service.status}/><span>{service.requests}</span><span>{service.error}</span><span>{service.p95}</span></div>)}
            </div>
          </article>

          <article className="panel cluster">
            <div className="panel-title"><div><h2>GKE cluster</h2><p>guenp-gke-robi-shared</p></div><StatusPill status="Healthy" /></div>
            <div className="cluster-stat"><span>Nodes</span><strong>12 / 12</strong></div>
            <div className="cluster-stat"><span>Pods</span><strong>184 / 188</strong></div>
            <div className="cluster-stat"><span>CPU requested</span><strong>68%</strong></div>
            <div className="bar"><i style={{width:'68%'}} /></div>
            <div className="cluster-stat"><span>Memory requested</span><strong>74%</strong></div>
            <div className="bar"><i style={{width:'74%'}} /></div>
          </article>

          <article className="panel activity">
            <div className="panel-title"><div><h2>Incident activity</h2><p>Alerts, deployments and Kubernetes events</p></div></div>
            {events.map((event) => <div className="event" key={`${event.time}-${event.title}`}><time>{event.time}</time><span className={`dot ${event.severity.toLowerCase()}`} /><div><strong>{event.title}</strong><p>{event.detail}</p></div></div>)}
          </article>

          <article className="panel trace">
            <div className="panel-title"><div><h2>Slowest trace</h2><p>POST /payment · trace 4da74f91</p></div><strong>1.42 s</strong></div>
            <div className="span"><span>NGINX ingress</span><i style={{width:'12%'}} /><b>18 ms</b></div>
            <div className="span"><span>billpay-api</span><i style={{width:'28%'}} /><b>220 ms</b></div>
            <div className="span"><span>customer-service</span><i style={{width:'23%'}} /><b>190 ms</b></div>
            <div className="span hot"><span>Cloud SQL query</span><i style={{width:'78%'}} /><b>980 ms</b></div>
          </article>
        </div>
      </section>
    </main>
  );
}
