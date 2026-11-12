import { cookies } from "next/headers";
import { ResearchNotebook } from "../../components/research-notebook";
import { findSession } from "../../server/repository";
import { sessionCookie } from "../../server/http";
export const dynamic = "force-dynamic";
export const metadata = { title: "Research notebook · WorldKit", robots: { index: false, follow: false } };
export default async function Page() {
  const session = await findSession((await cookies()).get(sessionCookie)?.value);
  if (!session) return <main className="bench-entry"><a href="/" className="bench-entry-brand">worldkit</a><p className="mini-label">THE RESEARCH NOTEBOOK</p><h1>Ask carefully.<br/>Keep what happened.</h1><p>Declare the tasks, record dated consent and preserve every attempt. Keep reported findings and fictional Sample rehearsals clear.</p><a className="primary-button" href="/">Open your private workbench</a><p>Then choose <strong>Research notebook</strong> in the workbench header. An expired workspace is never renewed by opening a study.</p></main>;
  return <ResearchNotebook/>;
}
