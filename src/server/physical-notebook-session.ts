import { cookies } from "next/headers";
import { WorldKitError } from "../../packages/contracts";
import type { BenchAccess } from "../../packages/physical-notebook/contracts";
import { requireSession } from "./http";
import { authenticateBenchReviewer, ownerBenchAccess } from "./physical-notebook-authority";
import { benchReviewerCookie } from "./physical-notebook-http";

export async function requireBenchAccess(reviewer = false): Promise<BenchAccess> {
  if (!reviewer) return ownerBenchAccess(await requireSession());
  const access = await authenticateBenchReviewer((await cookies()).get(benchReviewerCookie)?.value);
  if (!access) throw new WorldKitError("forbidden", "Open a current private reviewer invitation to inspect this report.", 401);
  return access;
}
