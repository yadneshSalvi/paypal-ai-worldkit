import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import "./globals.css";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
export const metadata: Metadata = { title: "WorldKit — Good gear. Better together.", description: "An evidence-aware creator workbench. Connect exact equipment, understand every signal, compare architectures and take a traceable plan to your desk.", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f6f7f5" };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en" className={`${inter.variable} ${sora.variable} ${mono.variable}`}><body>{children}</body></html>; }
