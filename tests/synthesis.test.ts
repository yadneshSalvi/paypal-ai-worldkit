import test from "node:test";
import assert from "node:assert/strict";
import { hash, graphHash } from "../packages/compatibility";
import type { DeviceProfile } from "../packages/contracts";
import type { Candidate, SynthesisInput } from "../packages/synthesis/contracts";
import { estimateCost } from "../packages/synthesis/cost";
import { sampleSynthesisInput } from "../packages/synthesis/sample";
import { dominates, evaluateCatalog, makeComparison, makeJourney, minimalRelaxations } from "../packages/synthesis/solver";
import { verifySystem } from "../packages/synthesis/validation";
import { comparisonFreshness } from "../src/server/synthesis";
import { inventoryFixture } from "./support/synthesis-fixture";

const setup = () => sampleSynthesisInput();
const candidate = (input: SynthesisInput, architecture = "T2") => evaluateCatalog(input).candidates.find(value => value.architecture === architecture && value.bundle.kit.components.find(component => component.role === "voice-1")?.profileId === "sample:dynamic-mic")!;
const changeProfile = (input: SynthesisInput, id: string, change: (profile: DeviceProfile) => void) => {
  const profile = input.profiles.find(value => value.id === `sample:${id}`)!; change(profile);
  input.offers = input.offers.map(offer => offer.profileId === profile.id ? { ...offer, profileHash: hash(profile) } : offer);
};
const edition = (input: SynthesisInput) => makeComparison(input, { id: "edition-fixture", sequence: 1, createdBy: "Sample owner" });
const result = (value: Candidate, id: string) => value.bundle.certificate.results.find(witness => witness.requirementId === id)!;

test("three objective labels identify distinct feasible complete graphs and stable non-dominated tradeoffs", () => {
  const input = setup(), saved = hash(input), values = evaluateCatalog(input).candidates;
  assert.equal(hash(input), saved, "enumeration must not mutate the current graph or catalog");
  assert.equal(values.length, 8);
  const labelled = values.filter(value => value.labels.length);
  assert.deepEqual(labelled.map(value => value.labels[0]), ["budget", "balanced", "upgrade"]);
  assert.equal(new Set(labelled.map(value => value.architecture)).size, 3);
  assert.equal(new Set(labelled.map(value => value.bundle.certificate.graphHash)).size, 3);
  assert.deepEqual(labelled.map(value => value.cost.landedMinor), [25300, 30900, 42400]);
  assert.ok(labelled.every(value => value.feasible && value.nondominated && value.bundle.certificate.sourceMode === "sample"));
  assert.ok(labelled.every(value => value.cost.lines.length === value.bundle.kit.components.length));
  assert.ok(labelled.every(value => value.bundle.kit.connections.every(edge => value.bundle.kit.components.some(component => component.role === `cable:${edge.id}`))));
  assert.ok(labelled.every(value => value.bundle.certificate.physicalTest === "not_performed"));
  assert.equal(candidate(input, "T1").soundcheck.supported, false);
  assert.equal(candidate(input, "T2").soundcheck.supported, true);
  assert.deepEqual(evaluateCatalog({ ...input, profiles: [...input.profiles].reverse(), offers: [...input.offers].reverse() }).candidates.map(value => [value.id, value.labels, value.dominatedBy]), values.map(value => [value.id, value.labels, value.dominatedBy]));
  const camera = candidate(input, "T4"); assert.ok(!camera.nondominated && camera.dominatedBy.includes(candidate(input, "T2").id));
});
test("the cheaper incompatible microphone cannot win, even with phantom switched on", () => {
  const input = setup(), low = evaluateCatalog(input).candidates.filter(value => value.bundle.kit.components.some(component => component.profileId === "sample:cheap-condenser"));
  assert.equal(low.length, 4); assert.ok(low.every(value => value.state === "violated" && !value.labels.length && !value.soundcheck.supported));
  const kit = structuredClone(low[0]!.bundle.kit); kit.components.find(component => component.role === "audio")!.settings.phantomEnabled = true;
  assert.equal(verifySystem(kit, input).certificate.status, "violated");
});
test("a missing critical premise or expired engineering edition stays unknown and cannot be relaxed into a green result", () => {
  for (const kind of ["value", "review", "source", "engineering", "port-review"] as const) {
    const input = setup();
    if (kind === "engineering") input.invalidProfileIds = ["sample:host"];
    else changeProfile(input, "host", profile => {
      if (kind === "value") { profile.facts.exactAppHardwareSupport!.value = null; profile.facts.exactAppHardwareSupport!.state = "unknown"; }
      if (kind === "review") profile.facts.exactAppHardwareSupport!.review = { status: "pending", reviewer: null, date: null };
      if (kind === "source") profile.facts.exactAppHardwareSupport!.sourceIds = ["missing-exact-source"];
      if (kind === "port-review") profile.portMapStatus = "pending";
    });
    const values = evaluateCatalog(input).candidates;
    assert.ok(values.every(value => !value.feasible && !value.labels.length));
    assert.equal(candidate(input).state, "unknown"); assert.equal(candidate(input).soundcheck.supported, false);
    assert.deepEqual(minimalRelaxations(input, values), []);
  }
});
test("a sourced false capture/monitor capability and unavailable listener output stay hard conflicts", () => {
  for (const [id, key] of [["capture", "uvcVideo"], ["capture", "exactHardwareRevision"], ["headphones", "stereoMonitoring"]]) {
    const input = setup(); changeProfile(input, id!, profile => { profile.facts[key!]!.value = false; });
    assert.equal(candidate(input).state, "violated");
  }
  const input = setup(); input.base.kit.goal.requirements.find(value => value.kind === "monitoring")!.target = 2;
  assert.equal(result(candidate(input), "system:monitor-count").status, "violated");
});
test("independently acceptable devices cannot oversubscribe the shared USB and power route", () => {
  const input = setup(); changeProfile(input, "hub", profile => { profile.facts.usbCapacityMbps!.value = 325; });
  assert.equal(result(candidate(input), "system:bandwidth").status, "violated");
  assert.equal(result(candidate(input, "T4"), "system:bandwidth").status, "satisfied");
  changeProfile(input, "hub", profile => { profile.facts.usbCapacityMbps!.value = 5000; profile.facts.peripheralPowerWatts!.value = 2; });
  assert.equal(result(candidate(input), "system:whole-power").status, "violated");
});
test("a shared output cannot become two physical jacks, even when its channel count is two", () => {
  const input = setup(), kit = candidate(input, "T4").bundle.kit;
  kit.connections.find(edge => edge.id === "audio-attenuator")!.from.portId = "phones";
  const checked = verifySystem(kit, input);
  assert.ok(checked.constraints.some(value => value.title === "One physical jack cannot be spent twice" && value.status === "violated"));
  assert.equal(checked.certificate.status, "violated");
});
test("exact cable ends, bandwidth, power and included battery premises are verified", () => {
  for (const [id, key, value, requirement] of [
    ["cable-usb_audio", "connectorA", "USB-B", "system:cable:audio-hub"],
    ["cable-uvc", "dataRateMbps", 10, "system:cable-bandwidth:capture-hub"],
    ["cable-usb_pd", "powerMaxWatts", 15, "system:cable-power:power-hub"],
  ] as const) {
    const input = setup(); changeProfile(input, id, profile => { profile.facts[key]!.value = value; });
    assert.equal(result(candidate(input), requirement).status, "violated");
  }
  const input = setup(); changeProfile(input, "recorder", profile => { profile.facts.batteryIncluded!.value = null; profile.facts.batteryIncluded!.state = "unknown"; });
  assert.equal(result(candidate(input), "system:recorder-batteries").status, "unknown");
});
test("software, firmware and recording media remain bound to each exact graph", () => {
  const input = setup(), kit = structuredClone(candidate(input).bundle.kit);
  kit.components.find(component => component.role === "host")!.settings.appVersion = "unsupported-next-version";
  assert.equal(verifySystem(kit, input).certificate.status, "violated");
  assert.notEqual(graphHash(kit, input.profiles), candidate(input).bundle.certificate.graphHash);
  changeProfile(input, "storage", profile => { profile.facts.recordingMediaSupported!.value = false; });
  assert.equal(result(candidate(input), "system:recording-media").status, "violated");
});
test("owned identity and total inventory quantities cannot be spent across duplicate positions", () => {
  const input = setup(), kit = structuredClone(candidate(input).bundle.kit), item = inventoryFixture(input.profiles.find(profile => profile.id === "sample:dynamic-mic")!);
  input.inventory = [item];
  for (const mic of kit.components.filter(component => component.role.startsWith("voice-"))) { mic.owned = true; mic.inventoryItemId = item.id; mic.ownershipSource = "user_confirmed"; }
  assert.equal(verifySystem(kit, input).constraints.find(value => value.requirementId === `system:inventory:${item.id}`)!.status, "violated");
  item.quantity = 2;
  assert.equal(verifySystem(kit, input).constraints.find(value => value.requirementId === `system:inventory:${item.id}`)!.status, "satisfied");
  kit.components.find(component => component.role === "camera")!.owned = false;
  assert.equal(verifySystem(kit, input).constraints.find(value => value.requirementId === "system:owned-preservation")!.status, "violated");
});
test("purchased equipment has no implicit replacement or refund authority", () => {
  const input = setup(), recorder = input.base.kit.components.find(component => component.role === "audio")!;
  input.purchased = [{ id: "Sample merchant commitment", version: 1, graphHash: input.base.certificate.graphHash, components: [recorder] }];
  assert.equal(candidate(input, "T1").state, "violated");
  assert.equal(candidate(input, "T2").state, "satisfied");
  assert.equal(candidate(input, "T3").state, "violated");
});
test("exact identity, currency, stale and newly unavailable offers cannot supply a valid complete price", () => {
  for (const change of ["identity", "currency", "expired", "unavailable", "shipping", "tax"] as const) {
    const input = setup(), offer = input.offers.find(offer => offer.profileId === "sample:dynamic-mic")!;
    if (change === "identity") offer.profileHash = "0".repeat(64);
    if (change === "currency") offer.currency = "EUR";
    if (change === "expired") offer.expiresAt = input.now;
    if (change === "unavailable") input.offers.push({ ...offer, id: "new-stock-out", observedAt: new Date(Date.parse(input.now) + 1000).toISOString(), availability: "unavailable" });
    if (change === "shipping") offer.shippingMinor = null;
    if (change === "tax") offer.taxMinor = null;
    const value = candidate(input), line = value.cost.lines.find(line => line.componentId === "mic-1")!;
    assert.equal(value.cost.landedMinor, null); assert.equal(value.feasible, false);
    assert.equal(line.state, ({ identity: "identity_mismatch", currency: "currency_mismatch", expired: "stale", unavailable: "unavailable", shipping: "current", tax: "current" })[change]);
    if (!["shipping", "tax"].includes(change)) assert.equal(line.subtotalMinor, null);
  }
});
test("cost arithmetic stays integer and planned reuse consumes each unit only once", () => {
  const input = setup(), kit = candidate(input).bundle.kit;
  const offer = input.offers.find(offer => offer.profileId === "sample:dynamic-mic")!; offer.unitMinor = 2501; offer.shippingMinor = 111; offer.taxMinor = 49;
  const cost = estimateCost(kit, input.profiles, input.offers, input.now, new Map([["sample:dynamic-mic", 1]]));
  assert.equal(cost.lines.find(line => line.componentId === "mic-1")!.kind, "planned_reuse");
  assert.equal(cost.lines.find(line => line.componentId === "mic-2")!.subtotalMinor, 2501);
  assert.equal(cost.shippingMinor, 111); assert.equal(cost.taxMinor, 49);
  assert.ok(Number.isSafeInteger(cost.landedMinor));
});
test("dominance is strict, has no fabricated result for unknown objectives, and labels never reuse one architecture", () => {
  const input = setup(), vectors = evaluateCatalog(input).candidates;
  for (const value of vectors) assert.equal(dominates(value.objectives, value.objectives), false);
  assert.equal(dominates({ ...vectors[0]!.objectives, landedMinor: null }, vectors[1]!.objectives), false);
  input.profiles = input.profiles.filter(profile => !["interface", "mixer"].includes(profile.kind));
  const labelled = evaluateCatalog(input).candidates.filter(value => value.labels.length);
  assert.equal(labelled.length, 1); assert.equal(new Set(labelled.map(value => value.architecture)).size, labelled.length);
});
test("an impossible budget offers the smallest explicit budget-only relaxation and retains the original goal", () => {
  const input = setup(); input.base.kit.goal.budgetMinor = 10000; input.base.kit.goal.requirements.find(value => value.kind === "budget")!.target = 10000;
  const original = hash(input.base), detail = edition(input);
  assert.equal(detail.outcome, "infeasible"); assert.equal(detail.relaxations.length, 1);
  const relaxation = detail.relaxations[0]!;
  assert.deepEqual(relaxation.changes.map(change => [change.kind, change.before, change.after]), [["budget", 10000, 25300]]);
  assert.equal(hash(input.base), original); assert.equal(detail.originalGoal.budgetMinor, 10000);
  assert.ok(evaluateCatalog(input, relaxation.proposedGoal).candidates.some(value => value.feasible));
  const almost = structuredClone(relaxation.proposedGoal); almost.budgetMinor--; almost.requirements.find(value => value.kind === "budget")!.target = almost.budgetMinor;
  assert.ok(evaluateCatalog(input, almost).candidates.every(value => !value.feasible));
});
test("fractional, missing and contradictory typed hard targets cannot silently use a default", () => {
  for (const target of [null, 0, -1, 2.5]) {
    const input = setup(); input.base.kit.goal.requirements.find(value => value.kind === "isolated_tracks")!.target = target;
    const checked = candidate(input); assert.equal(result(checked, "system:typed-goal").status, target === null ? "unknown" : "violated"); assert.equal(checked.feasible, false);
  }
  const input = setup(); input.base.kit.goal.requirements.find(value => value.kind === "budget")!.target = 100;
  assert.equal(result(candidate(input), "system:typed-goal").status, "violated");
});
test("large hard targets stay unsatisfied within the explicit generation bound and relax only to sourced capacity", () => {
  const input = setup(); input.base.kit.goal.requirements.find(value => value.kind === "isolated_tracks")!.target = 10000;
  const checked = edition(input); assert.equal(checked.outcome, "infeasible");
  assert.equal(checked.goal.requirements.find(value => value.kind === "isolated_tracks")!.target, 10000);
  assert.ok(checked.candidates.every(value => value.bundle.kit.components.filter(component => component.role.startsWith("voice-")).length <= 32 && !value.feasible));
  assert.equal(checked.relaxations.find(value => value.changes[0]!.kind === "tracks")!.changes[0]!.after, 6);
});
test("an impossible input count can explicitly reduce to the largest actually supported whole system", () => {
  const input = setup(); input.base.kit.goal.requirements.find(value => value.kind === "isolated_tracks")!.target = 8;
  const detail = edition(input), relaxation = detail.relaxations.find(value => value.changes.length === 1 && value.changes[0]!.kind === "tracks")!;
  assert.ok(relaxation); assert.equal(relaxation.changes[0]!.after, 6);
  const almost = structuredClone(relaxation.proposedGoal); almost.requirements.find(value => value.kind === "isolated_tracks")!.target = 7;
  assert.ok(evaluateCatalog(input, almost).candidates.every(value => !value.feasible));
  assert.ok(evaluateCatalog(input, relaxation.proposedGoal).candidates.some(value => value.feasible));
});
test("every version-vector change and offer expiration invalidates an edition without rewriting it", () => {
  const input = setup(), saved = edition(input), before = hash(saved);
  assert.equal(comparisonFreshness(saved, input).current, true);
  for (const field of Object.keys(input.basis) as (keyof SynthesisInput["basis"])[]) {
    const next = structuredClone(input); Object.assign(next.basis, { [field]: typeof next.basis[field] === "number" ? 2 : "changed" });
    assert.ok(comparisonFreshness(saved, next).changes.some(change => change.field === field));
  }
  assert.ok(comparisonFreshness(saved, { ...input, now: "2026-12-12T00:00:00.000Z" }).changes.some(change => change.field === "offers_expired"));
  assert.equal(hash(saved), before);
});
test("upgrade stages preserve the original, verify separately, and price conditional reuse without claiming purchases", () => {
  const input = setup(), saved = edition(input), first = saved.candidates.find(value => value.labels.includes("budget"))!, later = saved.candidates.find(value => value.labels.includes("upgrade"))!;
  const snapshot = hash(input.base), journey = makeJourney(input, saved, first, later, "sample-journey");
  assert.equal(hash(journey.origin), snapshot); assert.equal(hash(input.base), snapshot);
  assert.equal(journey.stages.length, 2);
  assert.ok(journey.stages.every(stage => stage.bundle.certificate.status === "satisfied" && stage.funding === "not_approved" && stage.fulfillment === "not_performed" && stage.status === "proposed"));
  assert.ok(journey.stages[1]!.reusedFromPreviousStage.length > 5);
  assert.ok(journey.stages[1]!.incrementalCost.landedMinor! < journey.stages[1]!.fullSystemCost.landedMinor!);
  assert.ok(journey.stages[1]!.diff.components.some(change => change.id === "audio" && change.kind === "changed"));
  assert.ok(journey.stages[1]!.prerequisites.some(value => value.includes("actually acquired")));
});
