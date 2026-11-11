import { createHash } from "node:crypto";
import { RULE_VERSION, type Architecture, type AssemblyStep, type CatalogSnapshot, type Certificate, type Component, type DeviceProfile, type Fact, type KitRevision, type Requirement, type Source, type Truth, type Witness } from "../contracts/index";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function graphHash(kit: KitRevision, profiles: DeviceProfile[]): string {
  return hash({ template: kit.templateId, goal: kit.goal, components: [...kit.components].sort((a, b) => a.id.localeCompare(b.id)).map(({ position: _position, ...component }) => ({ ...component, profileVersion: profiles.find(p => p.id === component.profileId)?.version ?? null, profileHash: hash(profiles.find(p => p.id === component.profileId) ?? null) })), connections: [...kit.connections].sort((a, b) => a.id.localeCompare(b.id)) });
}
export function combine(states: Truth[]): Truth { return states.includes("violated") ? "violated" : states.includes("unknown") ? "unknown" : "satisfied"; }
const unique = <T,>(items: T[]): T[] => [...new Set(items)];
type Context = { kit: KitRevision; profiles: DeviceProfile[]; sources: Source[]; templates: Architecture[]; snapshots: CatalogSnapshot[]; now: string };
type Evaluation = { status: Truth; title: string; explanation: string; components?: string[]; connections?: string[]; facts?: Fact[]; action?: string };
function getDevice(ctx: Context, component: Component | undefined) { return ctx.profiles.find(p => p.id === component?.profileId); }
function sourceExists(ctx: Context, fact: Fact): boolean { return fact.sourceIds.length > 0 && fact.sourceIds.every(id => ctx.sources.some(s => s.id === id && /^[a-f0-9]{64}$/.test(s.contentHash) && ["manufacturer", "software_publisher", "sample"].includes(s.kind))); }
function factState(ctx: Context, fact: Fact | undefined): Truth {
  if (!fact || fact.state === "unknown" || fact.value === null || !sourceExists(ctx, fact)) return "unknown";
  if (fact.state === "conflicted" || fact.review.status === "rejected") return "unknown";
  return "satisfied";
}
function pathExists(ctx: Context, start: string, end: string, kinds?: string[]): boolean {
  const seen = new Set<string>(); const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === end) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const e of ctx.kit.connections) if (e.enabled && e.from.componentId === node && (!kinds || kinds.includes(e.signal))) queue.push(e.to.componentId);
  }
  return false;
}
export function connectionIssues(kit: KitRevision, profiles: DeviceProfile[]): { id: string; status: Truth; reason: string }[] {
  const issues: { id: string; status: Truth; reason: string }[] = [];
  const consumed = new Set<string>();
  for (const edge of kit.connections) {
    if (!edge.enabled) { issues.push({ id: edge.id, status: "violated", reason: `${edge.cable} is disconnected.` }); continue; }
    const fromProfile = profiles.find(p => p.id === kit.components.find(c => c.id === edge.from.componentId)?.profileId);
    const toProfile = profiles.find(p => p.id === kit.components.find(c => c.id === edge.to.componentId)?.profileId);
    const from = fromProfile?.ports.find(p => p.id === edge.from.portId); const to = toProfile?.ports.find(p => p.id === edge.to.portId);
    if (!from || !to) { const incomplete = (!from && (!fromProfile || fromProfile.reviewState === "candidate" || fromProfile.portMapStatus === "pending")) || (!to && (!toProfile || toProfile.reviewState === "candidate" || toProfile.portMapStatus === "pending")); issues.push({ id: edge.id, status: incomplete ? "unknown" : "violated", reason: incomplete ? "This exact equipment identity still needs a source-backed port map before this connection can be checked." : "A named device port is missing from this exact profile." }); continue; }
    if (from.direction === "in" || to.direction === "out") { issues.push({ id: edge.id, status: "violated", reason: "The cable connects ports in the wrong signal direction." }); continue; }
    if (!from.protocols.includes(edge.protocol) || !to.protocols.includes(edge.protocol)) { issues.push({ id: edge.id, status: "violated", reason: `These ports do not both carry ${edge.protocol.replaceAll("_", " ")}. Connector shape is insufficient.` }); continue; }
    const same = from.connector === to.connector;
    const typedCable = (from.connector === "Micro HDMI" && to.connector === "HDMI" && edge.cable.includes("Micro HDMI")) || (from.connector === "6.35mm TRS" && to.connector === "3.5mm TRS" && edge.cable.includes("6.35"));
    if (!same && !typedCable) { issues.push({ id: edge.id, status: "unknown", reason: "An exact cable or converter is needed between these connector types." }); continue; }
    const key = `${edge.to.componentId}:${edge.to.portId}`;
    if (consumed.has(key)) { issues.push({ id: edge.id, status: "violated", reason: "Two cables consume the same single input port." }); continue; }
    consumed.add(key);
  }
  return issues;
}

function evaluate(ctx: Context, requirement: Requirement): Evaluation {
  const { kit } = ctx; const audio = kit.components.find(c => c.role === "audio"); const audioProfile = getDevice(ctx, audio);
  const host = kit.components.find(c => c.role === "host"); const hostProfile = getDevice(ctx, host);
  const mics = kit.components.filter(c => /^voice-\d+$/.test(c.role));
  if (!requirement.confirmed) return { status: "unknown", title: "Confirm this goal", explanation: "This requirement was proposed and has not been confirmed.", action: "Review the goal" };
  switch (requirement.kind) {
    case "isolated_tracks": {
      const target = requirement.target ?? 2;
      if (!audio || mics.length < target) return { status: "violated", title: "A microphone path is missing", explanation: `The goal needs ${target} separate microphone inputs.`, components: mics.map(m => m.id), action: "Restore the missing source" };
      const edges = kit.connections.filter(e => e.enabled && mics.some(m => m.id === e.from.componentId) && e.to.componentId === audio.id && e.signal === "audio");
      if (edges.length < target || unique(edges.map(e => e.to.portId)).length < target) return { status: "violated", title: "Each voice needs its own input", explanation: "One of the microphone paths is disconnected or two voices share the same input.", components: mics.map(m => m.id), connections: kit.connections.filter(e => mics.some(m => m.id === e.from.componentId)).map(e => e.id), action: "Reconnect each microphone to a different input" };
      const channels = audioProfile?.facts.independentChannels;
      if (factState(ctx, channels) === "unknown") return { status: "unknown", title: "Input count needs evidence", explanation: "Independent channels must be sourced for this exact model.", components: [audio.id], facts: channels ? [channels] : [], action: "Review the recorder source" };
      if (typeof channels?.value !== "number" || channels.value < target) return { status: "violated", title: "There are too few independent inputs", explanation: `${target} separate inputs are required.`, components: [audio.id], facts: channels ? [channels] : [] };
      const fact = kit.templateId === "T1" ? hostProfile?.facts.hostIsolatedWhileStreaming : audioProfile?.facts.onboardIsolated;
      if (factState(ctx, fact) === "unknown") return { status: "unknown", title: "Two inputs aren’t proof of two files", explanation: kit.templateId === "T1" ? "No reviewed source confirms that this exact tablet app records isolated microphone tracks while streaming." : "The selected recording device needs an exact isolated-track recording source.", components: [kit.templateId === "T1" ? host!.id : audio.id], facts: fact ? [fact] : [], action: "Compare a recorder architecture" };
      if (fact?.value !== true) return { status: "violated", title: "This route does not record separate files", explanation: "The selected recording destination lacks onboard isolated recording.", components: [audio.id], facts: fact ? [fact] : [] };
      return { status: "satisfied", title: "Each voice keeps its own track", explanation: `${target} independent inputs reach the recording path. The documented recording mode writes the selected tracks separately.`, components: [...mics.map(m => m.id), audio.id], connections: edges.map(e => e.id), facts: [channels!, fact!] };
    }
    case "camera_stream": {
      const camera = kit.components.find(c => c.role === "camera"); const capture = kit.components.find(c => c.role === "capture");
      if (!camera || !capture || !host || !pathExists(ctx, camera.id, host.id, ["video", "data"])) return { status: "violated", title: "The camera path is broken", explanation: "Video must travel from camera through capture and hub to the streaming tablet.", components: [camera?.id, capture?.id, host?.id].filter(Boolean) as string[], connections: kit.connections.filter(e => ["camera-capture", "capture-hub", "hub-host"].includes(e.id)).map(e => e.id), action: "Reconnect the video path" };
      const cp = getDevice(ctx, camera); const cap = getDevice(ctx, capture);
      const facts = [cp?.facts.hdmi1080p60, cap?.facts.uvcVideo, hostProfile?.facts.externalVideoAudio, cp?.facts.cleanHdmi, cap?.facts.exactHardwareRevision, hostProfile?.facts.exactAppHardwareSupport].filter(Boolean) as Fact[];
      if (facts.length < 6 || facts.some(f => factState(ctx, f) === "unknown") || camera.settings.cleanHdmiConfirmed !== true) return { status: "unknown", title: "The path is there. Confirm the exact settings.", explanation: "HDMI and USB connect, but clean camera output, capture hardware revision and this exact OS/app combination still need confirmation.", components: [camera.id, capture.id, host.id], facts, action: "Open the video evidence" };
      return { status: "satisfied", title: "The camera reaches the stream", explanation: "The selected camera, capture and app modes have a complete sourced path.", components: [camera.id, capture.id, host.id], facts };
    }
    case "monitoring": {
      const monitor = kit.components.find(c => c.role === "monitor");
      if (!audio || !monitor || !pathExists(ctx, audio.id, monitor.id, ["audio"])) return { status: "violated", title: "The headphones are disconnected", explanation: "A monitoring connection is needed to hear the recorder mix.", components: ["audio", "headphones"], connections: ["audio-monitor"], action: "Reconnect the headphones" };
      return { status: "satisfied", title: "You can follow the monitor path", explanation: "A stereo audio connection runs from the recorder to the selected headphone input. Exact hardware performance remains untested.", components: [audio.id, monitor.id], connections: ["audio-monitor"], facts: Object.values(audioProfile?.facts ?? {}).filter(f => f.property === "onboardIsolated") };
    }
    case "power": {
      for (const mic of mics) {
        const mp = getDevice(ctx, mic); const need = mp?.facts.phantomRequired;
        if (need?.value === true) {
          const supply = audioProfile?.facts.phantomVoltage; const required = mp?.facts.phantomVoltage;
          if (audio?.settings.phantomEnabled !== true || typeof supply?.value !== "number" || typeof required?.value !== "number" || supply.value < required.value) return { status: "violated", title: `${mp!.model} needs phantom power`, explanation: `This microphone requires ${required?.value ?? "48"} V. Phantom power is off in the saved recorder settings, so this input cannot work as configured.`, components: [mic.id, audio?.id ?? "audio"], connections: kit.connections.filter(e => e.from.componentId === mic.id).map(e => e.id), facts: [need, required, supply].filter(Boolean) as Fact[], action: "Review a compatible power repair" };
          if ([need, required, supply].some(f => factState(ctx, f) === "unknown")) return { status: "unknown", title: "Confirm the microphone power specification", explanation: "A source is missing or conflicting for the microphone or recorder’s power mode.", components: [mic.id, audio!.id], facts: [need, required, supply].filter(Boolean) as Fact[], action: "Review power evidence" };
        } else if (factState(ctx, need) === "unknown") return { status: "unknown", title: "The microphone’s power needs are unknown", explanation: "A dynamic-looking microphone still needs an exact source-backed profile.", components: [mic.id], facts: need ? [need] : [], action: "Review the microphone profile" };
      }
      const hub = getDevice(ctx, kit.components.find(c => c.role === "hub")); const supply = getDevice(ctx, kit.components.find(c => c.role === "power")); const capture = getDevice(ctx, kit.components.find(c => c.role === "capture"));
      const facts = [hub?.facts.peripheralPowerWatts, supply?.facts.powerWatts, capture?.facts.powerWatts].filter(Boolean) as Fact[];
      if (facts.length < 3 || facts.some(f => factState(ctx, f) === "unknown")) return { status: "unknown", title: "Finish the hub’s power budget", explanation: "Microphone power is accounted for. The exact supply, capture demand and hub’s peripheral allowance still need evidence.", components: ["hub", "capture", "power"], connections: ["power-hub"], facts, action: "Source the exact power supply" };
      const available = Number(hub!.facts.peripheralPowerWatts!.value); const demand = Number(capture!.facts.powerWatts!.value);
      if (demand > available) return { status: "violated", title: "The hub cannot supply enough power", explanation: `The documented ${demand} W load exceeds the ${available} W peripheral allowance.`, components: ["hub", "capture"], facts };
      return { status: "satisfied", title: "The selected loads fit", explanation: "Sourced peripheral demand is within the documented supply budget.", facts };
    }
    case "budget": {
      const options = (values: DeviceProfile["selectedOptions"]) => canonical(values.map(value => `${value.name.toLowerCase()}=${value.value}`).sort());
      const required = kit.components.filter(c => !c.owned); const priced = required.map(c => {
        const profile = getDevice(ctx, c); const snapshot = [...ctx.snapshots].sort((a,b) => b.observedAt.localeCompare(a.observedAt)).find(s => s.productId === profile?.catalogBinding?.productId && s.detailChecked && s.variantExact && options(s.selectedOptions) === options(profile.selectedOptions) && Date.parse(ctx.now) - Date.parse(s.observedAt) <= 15 * 60_000 && Date.parse(s.observedAt) <= Date.parse(ctx.now) + 60_000);
        return { component: c, snapshot };
      });
      const known = priced.flatMap(({ component, snapshot }) => {
        const values = snapshot?.offers.filter(o => o.price && ["InStock", "in_stock", "available"].includes(o.availability)).map(o => o.price!.minor) ?? [];
        return values.length ? [Math.min(...values) * component.quantity] : [];
      });
      const subtotal = known.reduce((a, b) => a + b, 0);
      if (subtotal > kit.goal.budgetMinor) return { status: "violated", title: "The known subtotal is already over budget", explanation: `Known new gear is $${(subtotal / 100).toFixed(2)}, before shipping, tax and unresolved accessories.`, components: required.map(c => c.id), action: "Compare alternatives or review the budget" };
      return { status: "unknown", title: "Refresh the complete landed cost", explanation: known.length ? `${known.length} of ${required.length} new components have exact current matches. Shipping, tax and required accessories must be resolved before the budget passes.` : "Live discovery can find current offers. No retailer subtotal is being invented for this saved plan.", components: required.map(c => c.id), action: "Discover current offers" };
    }
    case "reuse": {
      const missing = kit.goal.requiredOwnedProfileIds.filter(id => !kit.components.some(c => (c.profileId === id || getDevice(ctx, c)?.baseProfileId === id) && c.owned));
      const owned = kit.components.filter(c => c.owned); const confirmed = owned.filter(c => c.ownershipSource === "user_confirmed").length;
      return missing.length ? { status: "violated", title: "The plan removed something you wanted to keep", explanation: "Owned-equipment constraints must remain intact unless you explicitly change the goal.", action: "Restore your equipment" } : { status: "satisfied", title: "Your required equipment stays", explanation: `Every required owned profile is retained. ${confirmed} ${confirmed === 1 ? "item has" : "items have"} ownership confirmed by you; ${owned.length - confirmed} remain labelled sample possessions.`, components: owned.map(c => c.id) };
    }
    case "simultaneous": {
      const template = ctx.templates.find(t => t.id === kit.templateId);
      if (!template) return { status: "unknown", title: "This architecture has no reviewed template", explanation: "A template must declare every simultaneous-mode obligation." };
      const checks = template.requiredFacts.map(spec => { const comp = kit.components.find(c => c.role === spec.role); const f = getDevice(ctx, comp)?.facts[spec.property]; return { spec, comp, f, status: factState(ctx, f) === "unknown" ? "unknown" as Truth : f?.value === spec.expected ? "satisfied" as Truth : "violated" as Truth }; });
      const facts = checks.map(x => x.f).filter(Boolean) as Fact[];
      if ((audioProfile?.baseProfileId ?? audioProfile?.id) === "zoom-h4essential" && (audio?.settings.recordingMode !== "Audio I/F + REC" || ![44100, 48000].includes(Number(audio?.settings.sampleRate)))) return { status: "violated", title: "This recorder mode cannot do both jobs", explanation: "H4essential simultaneous SD recording and USB audio requires Audio I/F + REC at 44.1 or 48 kHz. The saved settings do not match.", components: ["audio"], facts, action: "Return to the documented 48 kHz mode" };
      const status = combine(checks.map(x => x.status));
      if (status !== "satisfied") return { status, title: "Don’t guess at simultaneous recording", explanation: kit.templateId === "T1" ? "The tablet route lacks a source proving isolated recording while the live camera stream runs." : `This architecture still needs ${checks.filter(x => x.status !== "satisfied").map(x => x.spec.property.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ")} evidence.`, components: unique(checks.filter(x => x.status !== "satisfied").map(x => x.comp?.id ?? "audio")), facts, action: "Compare a sourced recorder route" };
      if (!audio || !host || !pathExists(ctx, audio.id, host.id)) return { status: "violated", title: "The recorded mix cannot reach the stream", explanation: "The recorder’s documented USB mode still needs a connected path to the host.", components: ["audio", "hub", "host"], connections: ["audio-hub", "hub-host"], facts, action: "Reconnect the recorder" };
      return { status: "satisfied", title: "The recorder can do both jobs", explanation: "The exact documented mode keeps isolated files on the card while sending a stereo mix over USB. Separate video and power checks still apply.", components: ["audio", "host"], connections: ["audio-hub", "hub-host"], facts };
    }
    case "connections": {
      const issues = connectionIssues(kit, ctx.profiles); const hard = issues.filter(i => i.status === "violated");
      if (issues.length) return { status: combine(issues.map(i => i.status)), title: hard.length ? "A connection needs attention" : "Confirm this converter", explanation: issues[0]!.reason, connections: issues.map(i => i.id), components: unique(kit.connections.filter(e => issues.some(i => i.id === e.id)).flatMap(e => [e.from.componentId, e.to.componentId])), action: "Inspect the highlighted cable" };
      return { status: "satisfied", title: "The named ports and protocols connect", explanation: `${kit.connections.length} modeled connections agree on direction and declared protocol. Cables still need exact procurement identities.`, connections: kit.connections.map(e => e.id) };
    }
    case "source_review": {
      const facts = kit.components.flatMap(c => Object.values(getDevice(ctx, c)?.facts ?? {})).filter(f => f.critical); const dedup = unique(facts.map(f => f.id)).map(id => facts.find(f => f.id === id)!);
      const unresolved = dedup.filter(f => factState(ctx, f) === "unknown" || f.review.status !== "reviewed" || !f.review.reviewer);
      if (unresolved.length) return { status: "unknown", title: "Independent review is still open", explanation: `${unresolved.length} critical fact records need a source or a real reviewer. Software checks cannot approve their own evidence, and no physical test has been performed.`, facts: unresolved, action: "Inspect the review queue" };
      return { status: "satisfied", title: "Critical facts have recorded reviews", explanation: "Every critical premise has a supported source and an explicit reviewer record. This is still a model result, not hardware test evidence.", facts: dedup };
    }
  }
}

export function verifyKit(kit: KitRevision, profiles: DeviceProfile[], sources: Source[], templates: Architecture[], snapshots: CatalogSnapshot[] = [], now = new Date().toISOString()): Certificate {
  const ctx: Context = { kit, profiles, sources, templates, snapshots, now };
  const routingIssues = connectionIssues(kit, profiles);
  const results: Witness[] = kit.goal.requirements.map(requirement => {
    const e = evaluate(ctx, requirement);
    const affected = routingIssues.filter(issue => e.connections?.includes(issue.id));
    if (e.status === "satisfied" && affected.length) {
      e.status = combine(affected.map(issue => issue.status)); e.title = e.status === "unknown" ? "The path needs exact port evidence" : "The path has a connection conflict";
      e.explanation = affected[0]!.reason; e.action = "Inspect the affected connection";
    }
    return { id: `${requirement.id}-${requirement.kind}`, requirementId: requirement.id, ruleId: `creator.${requirement.kind}.v1`, status: e.status, title: e.title, explanation: e.explanation, componentIds: e.components ?? [], connectionIds: e.connections ?? [], factIds: unique((e.facts ?? []).map(f => f.id)), sourceIds: unique((e.facts ?? []).flatMap(f => f.sourceIds)), nextAction: e.action ?? null };
  });
  // Missing review coverage cannot be bypassed by removing the review requirement.
  const facts = unique(kit.components.map(c => c.profileId)).flatMap(id => Object.values(profiles.find(p => p.id === id)?.facts ?? {})).filter(f => f.critical);
  const reviewed = facts.filter(f => factState(ctx, f) === "satisfied" && f.review.status === "reviewed" && f.review.reviewer).length;
  const gHash = graphHash(kit, profiles); const sHash = hash({ sources: sources.map(({ id, contentHash }) => ({ id, contentHash })).sort((a, b) => a.id.localeCompare(b.id)), facts: facts.slice().sort((a, b) => a.id.localeCompare(b.id)), snapshots: snapshots.map(s => ({ id: s.id, responseHash: s.responseHash })).sort((a, b) => a.id.localeCompare(b.id)) });
  const hardResults = results.filter(r => kit.goal.requirements.find(q => q.id === r.requirementId)?.hard).map(r => r.status);
  return { id: `cert_${hash({ graph: gHash, sources: sHash, rules: RULE_VERSION, results }).slice(0, 32)}`, revisionId: kit.id, graphHash: gHash, ruleVersion: RULE_VERSION, sourceHash: sHash,
    status: combine([...hardResults, reviewed === facts.length && facts.length > 0 ? "satisfied" : "unknown"]), issuedAt: now, sourceMode: "modelled", results,
    counts: { satisfied: results.filter(r => r.status === "satisfied").length, violated: results.filter(r => r.status === "violated").length, unknown: results.filter(r => r.status === "unknown").length },
    review: { required: facts.length, reviewed, pending: facts.length - reviewed }, scope: "Computational routing and source-backed constraints; physical performance not tested.", physicalTest: "not_performed" };
}

export function generateAssembly(kit: KitRevision, profiles: DeviceProfile[]): AssemblyStep[] {
  const name = (id: string) => profiles.find(p => p.id === kit.components.find(c => c.id === id)?.profileId)?.model ?? id;
  const port = (componentId: string, id: string) => profiles.find(p => p.id === kit.components.find(c => c.id === componentId)?.profileId)?.ports.find(p => p.id === id)?.label ?? id;
  return kit.connections.map((edge, index) => ({ id: `step:${edge.id}`, index: index + 1, connectionId: edge.id, title: `${name(edge.from.componentId)} → ${name(edge.to.componentId)}`, instruction: `Connect ${port(edge.from.componentId, edge.from.portId)} to ${port(edge.to.componentId, edge.to.portId)} using ${edge.cable.toLowerCase()}.`, test: edge.signal === "power" ? "Confirm the exact supply and cable against the device manuals before powering the system." : edge.signal === "audio" ? "Check this modeled signal path, then confirm the actual device settings before hardware use." : edge.signal === "video" ? "Confirm the documented camera output mode and inspect the capture preview." : "Confirm this is a data-capable cable and select the documented device mode.", sourceIds: edge.sourceIds, signal: edge.signal, componentIds: [edge.from.componentId, edge.to.componentId] }));
}

export function suggestRepairs(kit: KitRevision, certificate: Certificate, profiles: DeviceProfile[] = []): { id: string; title: string; description: string; change: "restore_connections" | "dynamic_mic" | "phantom_on" | "recorder_mode" | "template_t2" }[] {
  const result = [];
  if (kit.connections.some(e => !e.enabled)) result.push({ id: "restore", title: "Reconnect the saved wiring", description: "Restore only disconnected paths and re-run every requirement.", change: "restore_connections" as const });
  if (kit.components.some(c => (profiles.find(p => p.id === c.profileId)?.baseProfileId ?? c.profileId) === "at2020-xlr") && certificate.results.some(r => r.requirementId === "R4" && r.status === "violated")) {
    result.push({ id: "phantom", title: "Use the recorder’s documented 48 V mode", description: "Keep the AT2020 and enable phantom in the saved plan. Follow the manual when handling physical gear.", change: "phantom_on" as const });
    result.push({ id: "dynamic", title: "Return to the dynamic microphone", description: "Restore the SM58 profile, which does not need external microphone power.", change: "dynamic_mic" as const });
  }
  if (kit.templateId === "T1") result.push({ id: "recorder", title: "Let a recorder keep the isolated tracks", description: "Move recording to the H4essential. The exact video, power and review gates remain visible.", change: "template_t2" as const });
  if (kit.components.find(c => c.role === "audio")?.settings.sampleRate === 96000) result.push({ id: "mode", title: "Use the documented simultaneous mode", description: "Set 48 kHz and Audio I/F + REC for the H4essential.", change: "recorder_mode" as const });
  return result;
}
