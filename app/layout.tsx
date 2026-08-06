import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SignalDeck",
  description: "OpenTelemetry-native observability for GCP and GKE",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
