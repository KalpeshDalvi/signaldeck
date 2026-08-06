"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const links = [
  ["Overview", "/"],
  ["Services", "/services"],
  ["Kubernetes", "/kubernetes"],
  ["Traces", "/traces"],
  ["Logs", "/logs"],
  ["Alerts", "/alerts"],
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <main className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand brand-link"><span className="logo">S</span><div><strong>SignalDeck</strong><small>GCP Observability</small></div></Link>
        <nav>
          {links.map(([label, href]) => (
            <Link className={pathname === href ? "active" : ""} href={href} key={href}>{label}</Link>
          ))}
        </nav>
        <div className="workspace"><small>Workspace</small><strong>BillPay Platform</strong><span>Production</span></div>
      </aside>
      <section className="content">{children}</section>
    </main>
  );
}

export function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <header><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div>{children ? <div className="header-actions">{children}</div> : null}</header>;
}
