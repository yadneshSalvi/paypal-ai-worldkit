import { z } from "zod";
import { WorldKitError, type KitRevision, type Certificate } from "../contracts/index";
import { seedKit } from "../device-library/index";
import { suggestRepairs } from "../compatibility/index";

export const EditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), templateId: z.enum(["T1", "T2", "T3", "T4"]) }).strict(),
  z.object({ kind: z.literal("connection"), connectionId: z.string(), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal("microphone"), componentId: z.enum(["mic-1", "mic-2"]), profileId: z.enum(["shure-sm58-lc", "at2020-xlr"]) }).strict(),
  z.object({ kind: z.literal("repair"), repairId: z.string() }).strict(),
  z.object({ kind: z.literal("sample_rate"), value: z.enum(["48000", "96000"]) }).strict(),
  z.object({ kind: z.literal("goal"), title: z.string().trim().min(1).max(80), brief: z.string().trim().min(10).max(2000), budgetMinor: z.number().int().min(1).max(1_000_000), tracks: z.number().int().min(1).max(8) }).strict(),
  z.object({ kind: z.literal("position"), componentId: z.string(), x: z.number().min(-2000).max(4000), y: z.number().min(-2000).max(4000) }).strict(),
]);
export type Edit = z.infer<typeof EditSchema>;
export const MutationSchema = z.object({ expectedRevisionId: z.string(), expectedGraphHash: z.string().length(64), edit: EditSchema }).strict();

function changeTemplate(kit: KitRevision, id: KitRevision["templateId"]) {
  const replacement = seedKit(id, kit.id, structuredClone(kit.goal));
  replacement.components = replacement.components.map(c => {
    const existing = kit.components.find(x => x.id === c.id);
    return existing && c.role !== "audio" ? { ...existing } : { ...c, position: existing?.position ?? c.position };
  });
  return { ...kit, templateId: id, components: replacement.components, connections: replacement.connections };
}
export function editKit(previous: KitRevision, certificate: Certificate, edit: Edit): KitRevision {
  let next = structuredClone(previous);
  const audio = next.components.find(c => c.role === "audio");
  switch (edit.kind) {
    case "template": next = changeTemplate(next, edit.templateId); break;
    case "connection": {
      const edge = next.connections.find(c => c.id === edit.connectionId);
      if (!edge) throw new WorldKitError("not_found", "This connection is not part of the saved revision.", 404);
      edge.enabled = edit.enabled; break;
    }
    case "microphone": next.components.find(c => c.id === edit.componentId)!.profileId = edit.profileId; break;
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
      const repair = suggestRepairs(previous, certificate).find(p => p.id === edit.repairId);
      if (!repair) throw new WorldKitError("stale_revision", "That repair is no longer applicable. Refresh the current checks.", 409);
      if (repair.change === "restore_connections") next.connections.forEach(c => { c.enabled = true; });
      if (repair.change === "phantom_on" && audio) audio.settings.phantomEnabled = true;
      if (repair.change === "dynamic_mic") next.components.filter(c => ["voice-1", "voice-2"].includes(c.role)).forEach(c => { c.profileId = "shure-sm58-lc"; });
      if (repair.change === "recorder_mode" && audio) { audio.settings.sampleRate = 48000; audio.settings.recordingMode = "Audio I/F + REC"; }
      if (repair.change === "template_t2") next = changeTemplate(next, "T2");
      break;
    }
  }
  return next;
}
