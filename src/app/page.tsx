import { cookies } from "next/headers";
import { WorldKitApp } from "@/components/worldkit-app";
import { findSession, getWorkspace } from "@/server/repository";
import { sessionCookie } from "@/server/http";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const cookie = (await cookies()).get(sessionCookie)?.value;
  const session = cookie ? await findSession(cookie) : null;
  const workspace = session ? await getWorkspace(session) : null;
  const query = await searchParams;
  return <WorldKitApp initialWorkspace={workspace} initialSection={typeof query.section === "string" ? query.section : "workbench"}/>;
}
