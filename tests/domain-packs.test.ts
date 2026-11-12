import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CatalogSnapshot, Certificate, Source, Truth } from "../packages/contracts";
import { hash } from "../packages/compatibility";
import { manifestFor, packHash, packManifests, packProfiles, packSources } from "../packages/domain-packs/catalog";
import { assertPackEdition, makePackEdition, packChanges, packGraphHash, packGuide, packRequirements, verifyPack } from "../packages/domain-packs/compiler";
import { PackCommandSchema, PackStateSchema, type PackConfig, type PackEdition, type PackState } from "../packages/domain-packs/contracts";
import { renderPackAudition } from "../packages/domain-packs/soundcheck";
import { catalogIdentityMatches } from "../packages/inventory/identity";

const at = "2026-11-12T05:00:00.000Z";
type Desk = Extract<PackConfig, { packId: "desk-displays" }>;
type Podcast = Extract<PackConfig, { packId: "podcast-classroom" }>;
function desk(changes: Partial<Desk> = {}): PackState {
  return { config: { packId: "desk-displays", host: "air-m3", displays: 2, lid: "closed", macos: "14.3", externalInputs: true, powerConnected: true, directPorts: true, ...changes }, disabledConnections: [], ownership: [], budgetMinor: 250000 };
}
function podcast(changes: Partial<Podcast> = {}): PackState {
  return { config: { packId: "podcast-classroom", recorder: "podtrak-p8", participants: 6, destination: "sd_card", storageConfirmed: true, powerConfirmed: true, keepTrackFiles: true, ...changes }, disabledConnections: [], ownership: [], budgetMinor: 150000 };
}
function edition(state: PackState, number = 1, parentEditionId: string | null = null): PackEdition {
  return makePackEdition(state, { id: `packrev_unit_${number}`, projectId: "pack_unit", edition: number, parentEditionId, title: "Independent manufacturer boundary case", at }, "Independent validation fixture");
}
function status(certificate: Certificate, id: string): Truth {
  const witness = certificate.results.find(result => result.requirementId === id);
  assert.ok(witness, `Missing requirement ${id}`);
  return witness.status;
}
function check(state: PackState): Certificate { return edition(state).certificate; }
function recompute(value: PackEdition): PackEdition {
  value.certificate = verifyPack(value.graph, value.profiles, value.sources, at);
  const { hash: _old, ...content } = value;
  value.hash = hash(content);
  return value;
}
function peak(samples: Float32Array, slot: number, sampleRate: number): number {
  let value = 0;
  for (let i = (slot - 1) * sampleRate; i < slot * sampleRate; i++) value = Math.max(value, Math.abs(samples[i]!));
  return value;
}

test("M2 exposes two video sockets but can drive only one native independent external display", () => {
  const two = edition(desk({ host: "air-m2", displays: 2, lid: "open", externalInputs: false }));
  const host = two.profiles.find(profile => profile.id === "pack-air-m2-2022")!;
  assert.equal(host.ports.filter(port => port.signal === "video").length, 2);
  assert.equal(two.graph.connections.filter(edge => edge.signal === "video" && edge.enabled).length, 2);
  assert.equal(status(two.certificate, "D1"), "violated");
  assert.equal(status(check(desk({ host: "air-m2", displays: 1, lid: "open", externalInputs: false })), "D1"), "satisfied");
});

for (const [name, changes] of [
  ["an open lid", { lid: "open" }],
  ["macOS 14.2", { macos: "14.2" }],
  ["no external keyboard and pointer", { externalInputs: false }],
  ["no external power", { powerConnected: false }],
] as const) {
  test(`M3 dual displays reject ${name} even when the other working conditions are present`, () => {
    const certificate = check(desk(changes));
    assert.equal(status(certificate, "D2"), "violated");
  });
}
for (const macos of ["14.3", "14.6", "15", "26"] as const) {
  test(`M3 dual displays accept the documented conditions at macOS ${macos}`, () => {
    const certificate = check(desk({ macos }));
    for (const id of ["D1", "D2", "D3", "C1"]) assert.equal(status(certificate, id), "satisfied");
    assert.notEqual(certificate.status, "satisfied");
  });
}
test("a single M3 display does not unnecessarily require dual-display closed-lid conditions", () => {
  const certificate = check(desk({ displays: 1, lid: "open", macos: "14.2", externalInputs: false, powerConnected: false }));
  assert.equal(status(certificate, "D1"), "satisfied");
  assert.equal(status(certificate, "D2"), "satisfied");
});
test("M3 requires two independent native output ports, not two cables assigned to one socket", () => {
  const certificate = check(desk({ directPorts: false }));
  assert.equal(status(certificate, "D3"), "violated");
});
test("a disconnected MagSafe path defeats the M3 dual-display power condition", () => {
  const state = desk(); state.disabledConnections = ["power-path"];
  assert.equal(status(check(state), "D2"), "violated");
});
test("a disconnected display path cannot count as an available independent screen", () => {
  const state = desk(); state.disabledConnections = ["display-path-2"];
  const certificate = check(state);
  assert.equal(status(certificate, "D3"), "violated");
  assert.equal(status(certificate, "C1"), "violated");
});
test("an absent required display edge cannot produce a passing path witness", () => {
  const value = edition(desk());
  value.graph.connections = value.graph.connections.filter(edge => edge.id !== "display-path-2");
  assert.notEqual(status(verifyPack(value.graph, value.profiles, value.sources, at), "D3"), "satisfied");
});
test("the Dell data-only or absent upstream port cannot masquerade as its video-capable input", () => {
  const value = edition(desk());
  value.profiles.find(profile => profile.id === "pack-dell-u2723qe")!.ports = [];
  const certificate = verifyPack(value.graph, value.profiles, value.sources, at);
  assert.notEqual(status(certificate, "D3"), "satisfied");
  assert.notEqual(status(certificate, "C1"), "satisfied");
});

for (const invalid of ["", "not-a-fingerprint", "f".repeat(63), "G".repeat(64)]) {
  test(`missing or malformed manufacturer fingerprint blocks the display capacity check (${invalid.length} chars)`, () => {
    const value = edition(desk());
    const sources = value.sources.map(source => source.id === "apple-air-m3" ? { ...source, contentHash: invalid } : source);
    assert.equal(status(verifyPack(value.graph, value.profiles, sources, at), "D1"), "unknown");
  });
}
test("a deleted or non-manufacturer source cannot support a passing native display claim", () => {
  const value = edition(desk());
  for (const sources of [value.sources.filter(source => source.id !== "apple-dual-m3"), value.sources.map(source => source.id === "apple-dual-m3" ? { ...source, kind: "sample" as Source["kind"] } : source)]) {
    assert.equal(status(verifyPack(value.graph, value.profiles, sources, at), "D1"), "unknown");
    assert.equal(status(verifyPack(value.graph, value.profiles, sources, at), "D2"), "unknown");
  }
});
test("a native display path cannot pass after the Dell upstream-port source is unavailable", () => {
  const value = edition(desk());
  const sources = value.sources.filter(source => source.id !== "dell-u2723qe");
  assert.notEqual(status(verifyPack(value.graph, value.profiles, sources, at), "D3"), "satisfied");
});
test("a source-backed false 4K display claim cannot be treated as a supported 4K mode", () => {
  const value = edition(desk());
  value.profiles.find(profile => profile.id === "pack-dell-u2723qe")!.facts.display4k60!.value = false;
  assert.notEqual(status(verifyPack(value.graph, value.profiles, value.sources, at), "D1"), "satisfied");
});
for (const state of ["unknown", "conflicted"] as const) {
  test(`a ${state} display fact cannot pass solely because its source exists`, () => {
    const value = edition(desk());
    value.profiles.find(profile => profile.id === "pack-air-m3-2024")!.facts.externalDisplays!.state = state;
    assert.equal(status(verifyPack(value.graph, value.profiles, value.sources, at), "D1"), "unknown");
  });
}
test("a rejected display claim cannot pass when manufacturer evidence remains present", () => {
  const value = edition(desk());
  value.profiles.find(profile => profile.id === "pack-air-m3-2024")!.facts.externalDisplays!.review.status = "rejected";
  assert.equal(status(verifyPack(value.graph, value.profiles, value.sources, at), "D1"), "unknown");
});

for (const participants of [2, 3, 4] as const) {
  test(`original P4 supports ${participants} local microphone and headphone positions`, () => {
    const certificate = check(podcast({ recorder: "podtrak-p4", participants, keepTrackFiles: false }));
    for (const id of ["P1", "P2", "P3"]) assert.equal(status(certificate, id), "satisfied");
  });
}
for (const participants of [5, 6] as const) {
  test(`original P4 cannot serve ${participants} distinct local microphones or headphone outputs`, () => {
    const value = edition(podcast({ recorder: "podtrak-p4", participants }));
    for (const id of ["P1", "P2", "P3", "C1"]) assert.equal(status(value.certificate, id), "violated");
    const recorder = value.profiles.find(profile => profile.id === "pack-podtrak-p4")!;
    assert.equal(recorder.ports.filter(port => port.id.startsWith("input")).length, 4);
    assert.equal(recorder.ports.filter(port => port.id.startsWith("phones")).length, 4);
    assert.match(recorder.variant, /not P4next/);
  });
}
test("original P8 supports all six local voices and six separate listening outputs", () => {
  const value = edition(podcast());
  for (const id of ["P1", "P2", "P3", "P4", "C1"]) assert.equal(status(value.certificate, id), "satisfied");
  const recorder = value.profiles.find(profile => profile.id === "pack-podtrak-p8")!;
  assert.equal(recorder.ports.filter(port => port.id.startsWith("input")).length, 6);
  assert.equal(recorder.ports.filter(port => port.id.startsWith("phones")).length, 6);
});
for (const recorder of ["podtrak-p4", "podtrak-p8"] as const) {
  test(`${recorder} USB stereo output never qualifies as isolated local microphone files`, () => {
    const certificate = check(podcast({ recorder, participants: recorder === "podtrak-p4" ? 4 : 6, destination: "usb_host" }));
    assert.equal(status(certificate, "P2"), "violated");
    assert.match(certificate.results.find(result => result.requirementId === "P2")!.explanation, /stereo USB mix/);
  });
}
test("P8 needs Keep Track Files even when all six microphone paths and media are planned", () => {
  assert.equal(status(check(podcast({ keepTrackFiles: false })), "P2"), "violated");
});
test("declaring power or SD media alone cannot complete the recorder plan", () => {
  for (const changes of [{ powerConfirmed: false }, { storageConfirmed: false }]) assert.equal(status(check(podcast(changes)), "P4"), "unknown");
  assert.equal(status(check(podcast({ storageConfirmed: false })), "P2"), "unknown");
});
test("a missing voice cable loses that input and its isolated file without removing the goal", () => {
  const state = podcast(); state.disabledConnections = ["voice-path-4"];
  const value = edition(state);
  for (const id of ["P1", "P2", "C1"]) assert.equal(status(value.certificate, id), "violated");
  assert.equal(packRequirements(state).find(requirement => requirement.id === "P1")!.target, 6);
  assert.equal(value.graph.state.config.packId === "podcast-classroom" && value.graph.state.config.participants, 6);
});
test("a headphone disconnect defeats monitoring without pretending a microphone disappeared", () => {
  const state = podcast(); state.disabledConnections = ["listen-path-6"];
  const certificate = check(state);
  assert.equal(status(certificate, "P3"), "violated");
  assert.equal(status(certificate, "P1"), "satisfied");
});
test("missing physical recorder ports do not retain passing input, file or listening witnesses", () => {
  const value = edition(podcast());
  const recorder = value.profiles.find(profile => profile.id === "pack-podtrak-p8")!;
  recorder.ports = recorder.ports.filter(port => !["input6", "phones6"].includes(port.id));
  const certificate = verifyPack(value.graph, value.profiles, value.sources, at);
  for (const id of ["P1", "P2", "P3", "C1"]) assert.notEqual(status(certificate, id), "satisfied");
});
test("two microphones sharing one physical recorder input cannot count as isolated voices", () => {
  const value = edition(podcast());
  value.graph.connections.find(edge => edge.id === "voice-path-6")!.to.portId = "input5";
  const certificate = verifyPack(value.graph, value.profiles, value.sources, at);
  assert.equal(status(certificate, "P1"), "violated");
  assert.equal(status(certificate, "P2"), "violated");
});
test("two listeners sharing one headphone socket cannot count as independent listening outputs", () => {
  const value = edition(podcast());
  value.graph.connections.find(edge => edge.id === "listen-path-6")!.from.portId = "phones5";
  assert.notEqual(status(verifyPack(value.graph, value.profiles, value.sources, at), "P3"), "satisfied");
});
test("the headphone path cannot pass when the headphone stereo evidence is unavailable", () => {
  const value = edition(podcast());
  assert.notEqual(status(verifyPack(value.graph, value.profiles, value.sources.filter(source => source.id !== "sony-mdr7506-pack"), at), "P3"), "satisfied");
});
test("a false isolated-file claim is not rescued by a valid source fingerprint", () => {
  const value = edition(podcast());
  value.profiles.find(profile => profile.id === "pack-podtrak-p8")!.facts.onboardIsolated!.value = false;
  assert.notEqual(status(verifyPack(value.graph, value.profiles, value.sources, at), "P2"), "satisfied");
});
test("a false documented battery-power capability cannot satisfy the planned recorder power check", () => {
  const value = edition(podcast());
  value.profiles.find(profile => profile.id === "pack-podtrak-p8")!.facts.batteryPower!.value = false;
  assert.notEqual(status(verifyPack(value.graph, value.profiles, value.sources, at), "P4"), "satisfied");
});

test("a synthesized P4 audition leaves fifth and sixth voice slots exactly silent", () => {
  const value = edition(podcast({ recorder: "podtrak-p4" }));
  const audition = renderPackAudition(value, "mix");
  assert.deepEqual(audition.paths.map(path => path.connected), [true, true, true, true, false, false]);
  for (let voice = 1; voice <= 4; voice++) assert.ok(peak(audition.samples, voice, audition.sampleRate) > 0.05);
  for (const voice of [5, 6]) {
    assert.equal(peak(audition.samples, voice, audition.sampleRate), 0);
    assert.equal(renderPackAudition(value, voice).peak, 0);
  }
});
test("P8 audition gives each voice its own time slot and never invents a disconnected input", () => {
  const state = podcast(); state.disabledConnections = ["voice-path-3"];
  const value = edition(state); const mix = renderPackAudition(value, "mix");
  for (let voice = 1; voice <= 6; voice++) {
    const isolated = renderPackAudition(value, voice);
    for (let slot = 1; slot <= 6; slot++) {
      if (slot === voice && voice !== 3) assert.ok(peak(isolated.samples, slot, isolated.sampleRate) > 0.05);
      else assert.equal(peak(isolated.samples, slot, isolated.sampleRate), 0);
    }
    assert.equal(peak(mix.samples, voice, mix.sampleRate) === 0, voice === 3);
  }
});
for (const changes of [{ destination: "usb_host" }, { keepTrackFiles: false }] as const) {
  test(`P8 audition does not invent isolated tracks for ${JSON.stringify(changes)}`, () => {
    const value = edition(podcast(changes));
    assert.ok(renderPackAudition(value, "mix").peak > 0);
    for (let voice = 1; voice <= 6; voice++) assert.equal(renderPackAudition(value, voice).peak, 0);
  });
}
test("an absent recorder input port is silent in the synthesized routing audition", () => {
  const value = edition(podcast());
  value.profiles.find(profile => profile.id === "pack-podtrak-p8")!.ports = value.profiles.find(profile => profile.id === "pack-podtrak-p8")!.ports.filter(port => port.id !== "input6");
  recompute(value);
  const audition = renderPackAudition(value, "mix");
  assert.equal(audition.paths[5]!.connected, false);
  assert.equal(peak(audition.samples, 6, audition.sampleRate), 0);
});
test("audition WAV is finite mono PCM with the exact graph's duration and valid chunk lengths", () => {
  const value = edition(podcast()); const audition = renderPackAudition(value, "mix");
  const view = new DataView(audition.wav); const ascii = (start: number, length: number) => new TextDecoder().decode(new Uint8Array(audition.wav, start, length));
  assert.equal(ascii(0, 4), "RIFF"); assert.equal(ascii(8, 4), "WAVE"); assert.equal(ascii(12, 4), "fmt "); assert.equal(ascii(36, 4), "data");
  assert.equal(view.getUint32(4, true), audition.wav.byteLength - 8);
  assert.equal(view.getUint32(16, true), 16); assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(24, true), 24000); assert.equal(view.getUint32(28, true), 48000); assert.equal(view.getUint16(32, true), 2);
  assert.equal(audition.seconds, 6); assert.equal(audition.samples.length, 6 * 24000);
  assert.equal(view.getUint32(40, true), audition.samples.length * 2);
  assert.equal(audition.wav.byteLength, 44 + audition.samples.length * 2);
  assert.ok(audition.samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1));
  assert.equal(audition.graphHash, value.certificate.graphHash);
  assert.equal(audition.sourceMode, "modelled"); assert.equal(audition.physicalTest, "not_performed");
  assert.match(audition.notice, /[Ss]ynthesized/); assert.match(audition.notice, /not tested/);
});
test("auditions reject non-podcast editions, invalid voice selectors and changed saved evidence", () => {
  assert.throws(() => renderPackAudition(edition(desk()), "mix"), /podcast/);
  const value = edition(podcast());
  for (const voice of [0, -1, 7, 1.5, NaN, Infinity]) assert.throws(() => renderPackAudition(value, voice), /voice/);
  value.graph.connections.find(edge => edge.id === "voice-path-1")!.enabled = false;
  assert.throws(() => renderPackAudition(value, "mix"), /immutable evidence/);
});

test("every pack preserves its explicit zero-review, zero-physical-test evidence boundary", () => {
  for (const manifest of packManifests) {
    assert.equal(manifest.actualHumanReviews, 0); assert.equal(manifest.physicalTests, 0);
    const value = edition(structuredClone(manifest.defaultState));
    assert.equal(value.certificate.sourceMode, "modelled"); assert.equal(value.certificate.physicalTest, "not_performed");
    assert.equal(value.certificate.review.reviewed, 0); assert.equal(status(value.certificate, "C3"), "unknown");
    assert.notEqual(value.certificate.status, "satisfied");
    assert.match(packGuide(value).at(-1)!.instruction, /actual|real/i);
    assert.match(packGuide(value).at(-1)!.instruction, /not|no physical/i);
  }
});
test("a very large budget and all owned equipment cannot manufacture current landed-price evidence", () => {
  const state = podcast(); state.budgetMinor = 1_000_000;
  const unbound = edition(state);
  state.ownership = unbound.graph.components.map(component => ({ componentId: component.id, inventoryItemId: `unit-owned-${component.id}`, inventoryVersion: 1, profileHash: hash(unbound.profiles.find(profile => profile.id === component.profileId)), quantity: component.quantity }));
  const bound = edition(state);
  assert.ok(bound.graph.components.every(component => component.owned));
  assert.equal(status(bound.certificate, "C2"), "unknown");
});
test("build normalizes caller-independent arrays and never edits the caller's plan", () => {
  const state = podcast(); state.disabledConnections = ["voice-path-6", "listen-path-1"];
  const before = structuredClone(state); edition(state);
  assert.deepEqual(state, before);
});
test("duplicate and out-of-configuration connection or ownership references are rejected", () => {
  const repeated = podcast(); repeated.disabledConnections = ["voice-path-1", "voice-path-1"];
  assert.throws(() => edition(repeated), /repeated/);
  const absent = podcast({ participants: 2 }); absent.disabledConnections = ["voice-path-6"];
  assert.throws(() => edition(absent), /does not belong/);
  const ownership = { componentId: "voice-6", inventoryItemId: "equipment", inventoryVersion: 1, profileHash: "a".repeat(64), quantity: 1 };
  const invalid = podcast({ participants: 2 }); invalid.ownership = [ownership];
  assert.throws(() => edition(invalid), /does not belong/);
  const duplicate = podcast(); duplicate.ownership = [ownership, ownership];
  assert.throws(() => edition(duplicate), /repeated/);
});
test("graph identity changes for meaningful requirements, settings, connections and exact profiles", () => {
  const base = edition(desk());
  for (const next of [desk({ displays: 1 }), desk({ lid: "open" }), desk({ host: "air-m2" }), desk({ directPorts: false })]) assert.notEqual(edition(next).certificate.graphHash, base.certificate.graphHash);
  const state = desk(); state.budgetMinor--;
  assert.notEqual(edition(state).certificate.graphHash, base.certificate.graphHash);
  const profiles = structuredClone(base.profiles); profiles[0]!.version++;
  assert.notEqual(packGraphHash(base.graph, profiles), base.certificate.graphHash);
});
test("canvas layout does not change the graph proof but changing saved bytes invalidates edition evidence", () => {
  const value = edition(desk()); const oldGraphHash = value.certificate.graphHash;
  value.graph.components[0]!.position.x += 100;
  assert.equal(packGraphHash(value.graph, value.profiles), oldGraphHash);
  assert.throws(() => assertPackEdition(value), /immutable evidence/);
});
test("an exact historical edition survives later compilation and cannot absorb source or graph drift", () => {
  const old = edition(podcast()); const bytes = JSON.stringify(old);
  edition(podcast({ recorder: "podtrak-p4", participants: 4 }), 2, old.id);
  assert.equal(JSON.stringify(old), bytes); assertPackEdition(old);
  for (const change of [
    (value: PackEdition) => { value.sources[0]!.contentHash = "0".repeat(64); },
    (value: PackEdition) => { value.certificate.results[0]!.status = "satisfied"; value.certificate.results[0]!.explanation += " changed"; },
    (value: PackEdition) => { value.graph.state.budgetMinor++; },
    (value: PackEdition) => { value.profiles[0]!.variant += " other variant"; },
    (value: PackEdition) => { value.reason += " modified"; },
  ]) {
    const altered = structuredClone(old); change(altered);
    assert.throws(() => assertPackEdition(altered), /immutable evidence/);
  }
});
test("equivalent graph plans retain the graph hash while later editions retain unique content identities", () => {
  const one = edition(desk()); const two = edition(desk(), 2, one.id);
  assert.equal(one.certificate.graphHash, two.certificate.graphHash);
  assert.notEqual(one.hash, two.hash); assert.notEqual(one.id, two.id);
});
test("catalog source bytes are fingerprinted and pack selection has an independently stable hash", () => {
  for (const source of packSources) assert.match(source.contentHash, /^[a-f0-9]{64}$/);
  assert.match(packHash("desk-displays"), /^[a-f0-9]{64}$/);
  assert.notEqual(packHash("desk-displays"), packHash("podcast-classroom"));
  assert.deepEqual(manifestFor("desk-displays").defaultState.ownership, []);
});
test("a preview changes the participant goal only through an explicit retained before/after change", () => {
  const before = podcast(); const after = podcast({ participants: 4 });
  assert.deepEqual(packChanges(before, after).find(change => change.field === "Participant goal"), { field: "Participant goal", before: "6", after: "4" });
  assert.equal(packRequirements(before).find(requirement => requirement.id === "P1")!.target, 6);
});
test("strict public state and commands reject out-of-range, mixed-pack or hidden authority fields", () => {
  const invalid = [
    { ...desk(), config: { ...desk().config, displays: 3 } },
    { ...podcast(), config: { ...podcast().config, participants: 7 } },
    { ...podcast(), config: { ...podcast().config, destination: "multitrack_usb" } },
    { ...desk(), config: { ...desk().config, recorder: "podtrak-p8" } },
    { ...podcast(), physicalTest: "passed" },
  ];
  for (const state of invalid) assert.equal(PackStateSchema.safeParse(state).success, false);
  const create = { kind: "create", requestId: randomUUID(), packId: "desk-displays", title: "Safe desk" };
  assert.equal(PackCommandSchema.safeParse(create).success, true);
  for (const extra of [{ scopes: ["kit:quote"] }, { tenantId: "other" }, { actualHumanReviews: 1 }]) assert.equal(PackCommandSchema.safeParse({ ...create, ...extra }).success, false);
  assert.equal(PackCommandSchema.safeParse({ kind: "grant", requestId: randomUUID(), projectId: "pack", expectedEditionId: "packrev", expectedVersion: 1, expectedGraphHash: "a".repeat(64), confirmedReadOnly: false }).success, false);
});

function catalogTitle(title: string, brand: string): CatalogSnapshot {
  return { id: "synthetic-domain-catalog", productId: "synthetic-domain-product", title, brand, description: "Synthetic exact-family identity boundary, no provider request or offer", selectedOptions: [], variantExact: true, offers: [], detailChecked: true, categoryIds: [], observedAt: at, source: "channel3", responseHash: "a".repeat(64), sourceMode: "live" };
}
for (const [profileId, title] of [
  ["pack-podtrak-p4", "Zoom PodTrak P4 original recorder"],
  ["pack-podtrak-p8", "Zoom PodTrak P8 original recorder"],
  ["pack-air-m2-2022", "Apple MacBook Air M2 13.6-inch 2022"],
  ["pack-air-m3-2024", "Apple MacBook Air M3 13.6-inch 2024"],
  ["pack-dell-u2723qe", "Dell UltraSharp U2723QE 27-inch"],
] as const) {
  test(`the exact ${profileId} catalog identity remains selectable`, () => {
    const profile = packProfiles.find(profile => profile.id === profileId)!;
    assert.equal(catalogIdentityMatches(catalogTitle(title, profile.manufacturer), profile), true);
  });
}
for (const [profileId, title] of [
  ["pack-podtrak-p4", "Zoom PodTrak P4next"],
  ["pack-podtrak-p4", "Zoom PodTrak P4 next recorder"],
  ["pack-podtrak-p4", "Zoom PodTrak P4 II"],
  ["pack-podtrak-p4", "Zoom PodTrak P4 Gen 2"],
  ["pack-podtrak-p8", "Zoom PodTrak P8next"],
  ["pack-podtrak-p8", "Zoom PodTrak P8 next recorder"],
  ["pack-podtrak-p8", "Zoom PodTrak P8 II"],
  ["pack-air-m2-2022", "Apple MacBook Air M2 15-inch 2023"],
  ["pack-air-m2-2022", "Apple MacBook Air M2 15.3-inch 2022"],
  ["pack-air-m2-2022", "Apple MacBook Air M2 13-inch 2024"],
  ["pack-air-m2-2022", "Apple MacBook Air M2 13-inch 2025"],
  ["pack-air-m3-2024", "Apple MacBook Air M3 15-inch 2024"],
  ["pack-air-m3-2024", "Apple MacBook Air M3 15.3-inch 2024"],
  ["pack-air-m3-2024", "Apple MacBook Air M3 13-inch 2022"],
  ["pack-air-m3-2024", "Apple MacBook Air M3 13-inch 2025"],
  ["pack-dell-u2723qe", "Dell U2723QE / U3223QE selectable monitor"],
  ["pack-dell-u2723qe", "Dell U3223QE 32-inch"],
] as const) {
  test(`${profileId} rejects the related catalog identity: ${title}`, () => {
    const profile = packProfiles.find(profile => profile.id === profileId)!;
    assert.equal(catalogIdentityMatches(catalogTitle(title, profile.manufacturer), profile), false);
  });
}
