import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { z } from "zod";
import { CartProblem, CartScopeSchema, type CartCredential, type CartPrincipal, type CartScope } from "./contracts";

const Header = z.object({ alg: z.literal("RS256"), typ: z.literal("JWT"), kid: z.string().min(1).max(120) }).strict();
const Claims = z.object({
  iss: z.literal("paypal.com"), sub: z.string().min(1).max(120), aud: z.string().min(1).max(200),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  scope: z.array(CartScopeSchema).min(1).max(2).refine(items => new Set(items).size === items.length),
  external_id: z.array(z.string().min(1).max(200)).min(2).max(10),
}).strict();
const denied = () => new CartProblem(401, "AUTHENTICATION_FAILED", "The merchant integration credential is unavailable, expired or invalid.");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function segment(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw denied();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw denied(); }
}
function parts(token: string) {
  if (token.length > 8192) throw denied();
  const values = token.split(".");
  if (values.length !== 3 || !values.every(Boolean)) throw denied();
  return values as [string, string, string];
}
export function cartCredentialLocator(authorization: string | null): { id: string; token: string } {
  const match = authorization && authorization.length <= 8200 ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
  if (!match) throw denied();
  const token = match[1]!; const [header] = parts(token);
  const value = Header.safeParse(segment(header)); if (!value.success) throw denied();
  return { id: value.data.kid, token };
}
export function verifyCartCredential(token: string, credential: CartCredential, required: CartScope, now = Date.now()): CartPrincipal {
  try {
    const [headerPart, bodyPart, signaturePart] = parts(token);
    const header = Header.parse(segment(headerPart)); const claims = Claims.parse(segment(bodyPart));
    const seconds = Math.floor(now / 1000);
    if (header.kid !== credential.id || credential.sourceMode !== "sample" || credential.revokedAt
      || Date.parse(credential.expiresAt) <= now || Date.parse(credential.sessionExpiresAt) <= now
      || !Number.isFinite(Date.parse(credential.expiresAt)) || !Number.isFinite(Date.parse(credential.sessionExpiresAt))
      || claims.exp <= seconds || claims.iat > seconds + 60 || claims.exp <= claims.iat || claims.exp - claims.iat > 3600
      || claims.exp * 1000 > Date.parse(credential.expiresAt) || claims.exp * 1000 > Date.parse(credential.sessionExpiresAt)
      || claims.sub !== credential.merchantId || claims.aud !== credential.audience || sha256(token) !== credential.tokenHash
      || claims.scope.some(scope => !credential.scopes.includes(scope))) throw denied();
    if (!claims.scope.includes(required) || !credential.scopes.includes(required)) throw new CartProblem(403, "INSUFFICIENT_SCOPE", "This integration credential does not permit this cart operation.");
    const accounts = claims.external_id.filter(id => id.startsWith("PayPal:"));
    const clients = claims.external_id.filter(id => id.startsWith("Client_Identifier:"));
    if (accounts.length !== 1 || accounts[0] !== `PayPal:${credential.accountId}` || clients.length !== 1 || clients[0] !== `Client_Identifier:${credential.clientId}`) throw denied();
    if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) throw denied();
    const signature = Buffer.from(signaturePart, "base64url"); if (signature.toString("base64url") !== signaturePart) throw denied();
    const key = createPublicKey(credential.publicKey);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || !verify("RSA-SHA256", Buffer.from(`${headerPart}.${bodyPart}`), key, signature)) throw denied();
    return { credentialId: credential.id, merchantId: credential.merchantId, tenantId: credential.tenantId, scopes: claims.scope, sourceMode: "sample", expiresAt: credential.expiresAt };
  } catch (error) { if (error instanceof CartProblem) throw error; throw denied(); }
}
export function issueCartCredential(input: { merchantId: string; tenantId: string; audience: string; accountId: string; scopes: CartScope[]; sessionExpiresAt: string }, now = Date.now()) {
  const seconds = Math.floor(now / 1000); const expires = Math.min(seconds + 3600, Math.floor(Date.parse(input.sessionExpiresAt) / 1000));
  if (!Number.isFinite(expires) || expires <= seconds || !input.scopes.length || new Set(input.scopes).size !== input.scopes.length) throw denied();
  const id = randomUUID(); const clientId = `WorldKitSample-${id}`;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify(Header.parse({ alg: "RS256", typ: "JWT", kid: id }))).toString("base64url");
  const claims = Claims.parse({ iss: "paypal.com", sub: input.merchantId, aud: input.audience, iat: seconds, exp: expires, scope: input.scopes, external_id: [`PayPal:${input.accountId}`, `Client_Identifier:${clientId}`] });
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url"); const payload = `${header}.${body}`;
  const token = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
  const credential: CartCredential = { id, merchantId: input.merchantId, tenantId: input.tenantId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), tokenHash: sha256(token), audience: input.audience, accountId: input.accountId, clientId, scopes: input.scopes, sourceMode: "sample", expiresAt: new Date(expires * 1000).toISOString(), revokedAt: null, sessionExpiresAt: input.sessionExpiresAt };
  return { credential, token };
}
