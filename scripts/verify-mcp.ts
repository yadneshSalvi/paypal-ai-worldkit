import { pathToFileURL } from "node:url";
import { parseVerificationArgs, VerificationFailure, verifyExistingMcpGrant } from "./lib/mcp-verification";

export async function main(args: string[]) {
  try {
    const options = parseVerificationArgs(args);
    if ("help" in options) {
      console.log("Usage: npm run verify:mcp -- --input /absolute/private-input.json --output /absolute/new-receipt.json\nUses one existing grant and exact saved certificate. Creates no workspace, grant, quote or payment. Never overwrites receipts or loads .env. See docs/RELEASE_READINESS.md.");
      return 0;
    }
    const result = await verifyExistingMcpGrant(options);
    console.log(JSON.stringify({ status: result.status, requestCount: result.requestCount, outputWritten: true, ...(result.failure ? { code: result.failure.code } : {}) }));
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ status: "held", code: error instanceof VerificationFailure ? error.code : "VERIFICATION_INPUT_OR_OUTPUT_UNAVAILABLE", automaticRetry: false }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
