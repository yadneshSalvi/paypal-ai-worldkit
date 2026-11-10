import { AlertCircle, Check, CircleHelp, LoaderCircle } from "lucide-react";
import type { Truth } from "../../packages/contracts/index";
export function Status({ value, short = false }: { value: Truth; short?: boolean }) { return <span className={`status ${value}`}>{value === "satisfied" ? <Check size={12}/> : value === "violated" ? <AlertCircle size={12}/> : <CircleHelp size={12}/>} {value === "satisfied" ? short ? "Pass" : "Model check passed" : value === "violated" ? "Needs a repair" : short ? "Open" : "Evidence needed"}</span>; }
export function Busy({ text = "Checking your plan…" }: { text?: string }) { return <span className="busy"><LoaderCircle className="spin" size={14}/>{text}</span>; }
export const currency = (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
export function shortTime(value: string) { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
export async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: data === undefined ? undefined : { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), cache: "no-store" });
  const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error?.message ?? "The request could not be completed."), { status: response.status, nextAction: value.error?.nextAction }); return value as T;
}
export function downloadJSON(value: unknown, name: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }
