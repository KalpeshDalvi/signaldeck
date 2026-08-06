import type { Metadata } from "next";
import "./globals.css";
import "./service-details.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "SignalDeck",
  description: "OpenTelemetry-native observability for GCP and GKE",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppShell>{children}</AppShell></body></html>;
}
