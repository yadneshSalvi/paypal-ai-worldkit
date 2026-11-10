import { SandboxPayPalProvider, type SandboxConfig } from "@fracture/paypal-core";
import { VaultAdapter } from "../../packages/commerce/vault";
const shared = globalThis as unknown as { worldkitPaymentProvider?: SandboxPayPalProvider };
export function sandboxConfig(): SandboxConfig {
  if (process.env.PAYPAL_ENVIRONMENT !== "sandbox") throw new Error("WorldKit requires its isolated sandbox environment.");
  return { environment: "sandbox", baseUrl: process.env.PAYPAL_API_BASE_URL ?? "", clientId: process.env.PAYPAL_CLIENT_ID ?? "", clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "", isolatedProject: process.env.PAYPAL_PROJECT_ISOLATED ?? "" };
}
export function paymentProvider() { return shared.worldkitPaymentProvider ??= new SandboxPayPalProvider(sandboxConfig()); }
export function vaultProvider() { return new VaultAdapter(paymentProvider().client); }
