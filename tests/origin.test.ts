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
