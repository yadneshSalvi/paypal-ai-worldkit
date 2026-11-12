import { handleWorkspace } from "@/server/workspace-admission-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleWorkspace;
export const HEAD = handleWorkspace;
export const POST = handleWorkspace;
