import assert from "node:assert/strict";
import test from "node:test";
import { trustedOrigin } from "../packages/security/origin";
const request = (origin: string, host = "127.0.0.1:4106", url = "http://localhost:4106/api/workspace") => new Request(url, { headers: { origin, host } });
test("the two project loopback aliases work with Next's normalized handler URL", () => {
  assert.equal(trustedOrigin(request("http://127.0.0.1:4106")), true);
  assert.equal(trustedOrigin(request("http://localhost:4106")), true);
});
test("local aliases do not authorize foreign origins, foreign Hosts, or another application port", () => {
  assert.equal(trustedOrigin(request("https://attacker.example")), false);
  assert.equal(trustedOrigin(request("http://127.0.0.1:4106", "attacker.example")), false);
  assert.equal(trustedOrigin(request("http://localhost:3101")), false);
  assert.equal(trustedOrigin(request("http://localhost:4106", "localhost:4106", "https://worldkit.example/api")), false);
});
test("a deployed origin requires the configured Host and exact origin", () => {
  const configured = "https://worldkit.example";
  assert.equal(trustedOrigin(request(configured, "worldkit.example", `${configured}/api`), configured), true);
  assert.equal(trustedOrigin(request("https://attacker.example", "worldkit.example", `${configured}/api`), configured), false);
  assert.equal(trustedOrigin(request(configured, "evil.example", `${configured}/api`), configured), false);
  assert.equal(trustedOrigin(request(`${configured}/bad`, "worldkit.example", `${configured}/api`), configured), false);
});

const publicOrigin = "https://paypal-ai-worldkit.vercel.app";
const deploymentHost = "paypal-ai-worldkit-abc123-user-projects.vercel.app";
const preview = `https://${deploymentHost}`;
test("the exact Vercel deployment host works alongside the configured stable domain", () => {
  assert.equal(trustedOrigin(request(preview, deploymentHost, `${preview}/api/workspace`), publicOrigin, deploymentHost), true);
  assert.equal(trustedOrigin(request(publicOrigin, new URL(publicOrigin).host, `${publicOrigin}/api/workspace`), publicOrigin, deploymentHost), true);
  assert.equal(trustedOrigin(request(preview, deploymentHost, `${publicOrigin}/api/workspace`), publicOrigin, deploymentHost), true);
});
test("two allowed hosts cannot send cross-origin mutations to each other", () => {
  assert.equal(trustedOrigin(request(publicOrigin, deploymentHost, `${preview}/api/workspace`), publicOrigin, deploymentHost), false);
  assert.equal(trustedOrigin(request(preview, new URL(publicOrigin).host, `${publicOrigin}/api/workspace`), publicOrigin, deploymentHost), false);
});
test("foreign preview aliases, suffix tricks, scheme and port changes remain denied", () => {
  for (const foreign of ["https://another-deployment.vercel.app", `${preview}.attacker.example`, "https://attacker.example", `http://${deploymentHost}`, `${preview}:444`]) {
    assert.equal(trustedOrigin(request(foreign, deploymentHost, `${preview}/api/workspace`), publicOrigin, deploymentHost), false);
    assert.equal(trustedOrigin(request(foreign, new URL(foreign).host, `${foreign}/api/workspace`), publicOrigin, deploymentHost), false);
  }
  assert.equal(trustedOrigin(request(`${preview}/path`, deploymentHost, `${preview}/api`), publicOrigin, deploymentHost), false);
  assert.equal(trustedOrigin(request("null", deploymentHost, `${preview}/api`), publicOrigin, deploymentHost), false);
});
test("forwarded host headers and a missing actual Host cannot grant preview origin authority", () => {
  const forged = new Request(`${preview}/api/workspace`, { headers: { origin: preview, host: "foreign.example", "x-forwarded-host": deploymentHost, forwarded: `host=${deploymentHost};proto=https` } });
  assert.equal(trustedOrigin(forged, publicOrigin, deploymentHost), false);
  assert.equal(trustedOrigin(new Request(`${preview}/api`, { headers: { origin: preview } }), publicOrigin, deploymentHost), false);
});
test("a malformed or absent deployment setting never creates a general Vercel allowlist", () => {
  for (const setting of [undefined, "*.vercel.app", preview, `${deploymentHost}/path`, `${deploymentHost}:443`, `${deploymentHost}.attacker.example`, `user@${deploymentHost}`, ` ${deploymentHost}`]) {
    assert.equal(trustedOrigin(request(preview, deploymentHost, `${preview}/api/workspace`), publicOrigin, setting), false);
  }
});
