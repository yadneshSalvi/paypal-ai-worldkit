import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
function secretKey(secret = process.env.AUTH_SECRET): Buffer {
  if (!secret || secret.length < 32) throw new Error("The project encryption secret is not configured.");
  return Buffer.from(hkdfSync("sha256", secret, "worldkit-private-identities-v1", "wallet-and-payment-authority", 32));
}
export function seal<T>(tenantId: string, value: T, secret?: string): { sealed: string } {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", secretKey(secret), iv);
  cipher.setAAD(Buffer.from(`worldkit:v1:${tenantId}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { sealed: `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}` };
}
export function unseal<T>(tenantId: string, data: { sealed: string }, secret?: string): T {
  const [version, iv, tag, encrypted] = data.sealed.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("The private record cannot be read.");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(`worldkit:v1:${tenantId}`)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8")) as T;
}
