import { cookies } from "next/headers";
import { PhysicalNotebook } from "../../components/physical-notebook";
import { findSession } from "../../server/repository";
import { sessionCookie } from "../../server/http";
export const dynamic = "force-dynamic";
export const metadata = { title: "Test notebook · WorldKit", robots: { index: false, follow: false } };
export default async function Page() {
  const session = await findSession((await cookies()).get(sessionCookie)?.value);
  if (!session) return <main className="bench-entry"><a href="/" className="bench-entry-brand">worldkit</a><p className="mini-label">THE TEST NOTEBOOK</p><h1>Keep the original.<br/>Record what happened.</h1><p>Bind a physical test to one saved system. Preserve the exact conditions, original files and independent review, including anything that failed.</p><a className="primary-button" href="/">Open your private workbench</a><p>Then choose <strong>Test notebook</strong> in the workbench header. A new notebook never renews an expired workspace.</p></main>;
  return <PhysicalNotebook/>;
}
