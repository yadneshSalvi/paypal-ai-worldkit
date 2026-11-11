import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { qualifyEngineeringPrincipal } from "../src/server/engineering-review";
import { closeDatabase } from "../src/server/db";

// This command is intentionally absent from browser routes. An actual operator
// must examine identity and qualification evidence before providing this private manifest.
const Input = z.object({ tenantId: z.uuid(), actorId: z.uuid(), identityHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  expertise: z.array(z.enum(["identity", "engineering", "simultaneous", "geometry"])).min(1).max(4),
  method: z.string().trim().min(20).max(800), issuer: z.string().trim().min(3).max(120), expiresAt: z.iso.datetime(),
  examinedOriginalIdentityEvidence: z.literal(true), examinedQualifications: z.literal(true), realHumanParticipation: z.literal(true),
}).strict();
const path = process.argv[2];
if (!path) throw new Error("Pass a private operator attestation manifest path. This does not infer qualifications from an invitation or model output.");
const file = await stat(path);
if (file.mode & 0o077) throw new Error("The attestation manifest must be owner-only (0600).");
if (file.size > 16000) throw new Error("The attestation manifest is too large.");
const input = Input.parse(JSON.parse(await readFile(path, "utf8")));
try {
  const { tenantId, actorId, examinedOriginalIdentityEvidence: _identity, examinedQualifications: _qualifications, realHumanParticipation: _human, ...qualification } = input;
  const result = await qualifyEngineeringPrincipal(tenantId, actorId, qualification);
  console.log(JSON.stringify({ recorded: true, qualificationId: result.qualificationId, physicalApproval: false, instruction: "Bind a new edition after author identity changes. Previous votes do not transfer." }));
} finally { await closeDatabase(); }
