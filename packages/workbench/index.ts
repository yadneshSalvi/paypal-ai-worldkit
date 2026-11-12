import { WorldKitError, type KitRevision, type Certificate, type DeviceProfile, type Component } from "../contracts/index";
import { seedKit, profiles as libraryProfiles } from "../device-library/index";
import { suggestRepairs } from "../compatibility/index";
import type { Edit } from "./contracts";
export { EditSchema, MutationSchema, type Edit } from "./contracts";

function changeTemplate(kit: KitRevision, id: KitRevision["templateId"]) {
  if (kit.templateId === id) return structuredClone(kit);
  const replacement = seedKit(id, kit.id, structuredClone(kit.goal));
  replacement.components = replacement.components.map(c => {
    const existing = kit.components.find(x => x.id === c.id);
    return existing && c.role !== "audio" ? { ...existing } : { ...c, position: existing?.position ?? c.position };
  });
  return { ...kit, templateId: id, components: replacement.components, connections: replacement.connections };
}
function chooseCandidate(component: Component, profileId: string) { component.profileId = profileId; component.owned = false; delete component.inventoryItemId; delete component.ownershipSource; }
export function editKit(previous: KitRevision, certificate: Certificate, edit: Edit, profiles: DeviceProfile[] = libraryProfiles): KitRevision {
  let next = structuredClone(previous);
  const audio = next.components.find(c => c.role === "audio");
  switch (edit.kind) {
    case "template": next = changeTemplate(next, edit.templateId); break;
    case "connection": {
      const edge = next.connections.find(c => c.id === edit.connectionId);
      if (!edge) throw new WorldKitError("not_found", "This connection is not part of the saved revision.", 404);
      edge.enabled = edit.enabled; break;
    }
    case "microphone": {
      const microphone = next.components.find(c => c.id === edit.componentId);
      if (!microphone) throw new WorldKitError("not_found", "This microphone is not part of the saved revision.", 404);
      chooseCandidate(microphone, edit.profileId); break;
    }
    case "sample_rate": if (audio) audio.settings.sampleRate = Number(edit.value); break;
    case "goal":
      next.goal = { ...next.goal, title: edit.title, brief: edit.brief, budgetMinor: edit.budgetMinor, version: next.goal.version + 1,
        requirements: next.goal.requirements.map(r => r.kind === "isolated_tracks" ? { ...r, target: edit.tracks, label: `${edit.tracks} separate tracks`, confirmed: true } : r.kind === "budget" ? { ...r, target: edit.budgetMinor, label: `New gear under $${(edit.budgetMinor / 100).toFixed(0)}`, confirmed: true } : r) };
      break;
    case "position": {
      const node = next.components.find(c => c.id === edit.componentId);
      if (!node) throw new WorldKitError("not_found", "This component is not part of the saved revision.", 404);
      node.position = { x: edit.x, y: edit.y }; break;
    }
    case "repair": {
      const repair = suggestRepairs(previous, certificate, profiles).find(p => p.id === edit.repairId);
      if (!repair) throw new WorldKitError("stale_revision", "That repair is no longer applicable. Refresh the current checks.", 409);
      if (repair.change === "restore_connections") next.connections.forEach(c => { c.enabled = true; });
      if (repair.change === "phantom_on" && audio) audio.settings.phantomEnabled = true;
      if (repair.change === "dynamic_mic") next.components.filter(c => ["voice-1", "voice-2"].includes(c.role) && (profiles.find(p => p.id === c.profileId)?.baseProfileId ?? c.profileId) === "at2020-xlr").forEach(c => { chooseCandidate(c, "shure-sm58-lc"); });
      if (repair.change === "recorder_mode" && audio) { audio.settings.sampleRate = 48000; audio.settings.recordingMode = "Audio I/F + REC"; }
      if (repair.change === "template_t2") next = changeTemplate(next, "T2");
      break;
    }
  }
  return next;
}
