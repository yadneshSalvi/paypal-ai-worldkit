import { handleMcp } from "@/server/mcp";
import { errorResponse } from "@/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) { try { return await handleMcp(request); } catch (error) { return errorResponse(error); } }
export async function GET(request: Request) { try { return await handleMcp(request); } catch (error) { return errorResponse(error); } }
export async function DELETE(request: Request) { try { return await handleMcp(request); } catch (error) { return errorResponse(error); } }
