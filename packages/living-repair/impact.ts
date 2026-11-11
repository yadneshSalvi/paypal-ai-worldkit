import { hash } from "../compatibility";
import type { RepairBundle, RepairImpact } from "./contracts";

/** The conservative closure follows enabled physical paths and every witness sharing
 * one of their components, connections or facts. Disconnected branches stay outside. */
export function affectedClosure(bundle: RepairBundle, changed: string[]): RepairImpact {
  const components = new Set(changed.filter(id => bundle.kit.components.some(component => component.id === id)));
  const connections = new Set<string>(); const requirements = new Set<string>(); const facts = new Set<string>(); const sources = new Set<string>();
  let grew = true;
  while (grew) {
    const size = components.size + connections.size + requirements.size + facts.size;
    for (const edge of bundle.kit.connections) {
      if (edge.enabled && (components.has(edge.from.componentId) || components.has(edge.to.componentId))) {
        connections.add(edge.id); components.add(edge.from.componentId); components.add(edge.to.componentId);
        edge.sourceIds.forEach(id => sources.add(id));
      }
    }
    for (const witness of bundle.certificate.results) {
      // Global source-review and all-connections witnesses enumerate the whole kit;
      // recheck them without letting those summary lists erase branch locality.
      const kind = bundle.kit.goal.requirements.find(requirement => requirement.id === witness.requirementId)?.kind;
      if (["source_review", "connections", "budget", "reuse"].includes(kind ?? "")) { requirements.add(witness.requirementId); continue; }
      if (witness.componentIds.some(id => components.has(id)) || witness.connectionIds.some(id => connections.has(id)) || witness.factIds.some(id => facts.has(id))) {
        requirements.add(witness.requirementId); witness.componentIds.forEach(id => components.add(id));
        witness.connectionIds.forEach(id => connections.add(id)); witness.factIds.forEach(id => facts.add(id)); witness.sourceIds.forEach(id => sources.add(id));
      }
    }
    for (const component of bundle.kit.components.filter(component => components.has(component.id))) {
      const profile = bundle.profiles.find(profile => profile.id === component.profileId);
      Object.values(profile?.facts ?? {}).filter(fact => fact.critical).forEach(fact => { facts.add(fact.id); fact.sourceIds.forEach(id => sources.add(id)); });
    }
    grew = size !== components.size + connections.size + requirements.size + facts.size;
  }
  const sorted = (values: Set<string>) => [...values].sort();
  return { changedComponentIds: [...new Set(changed)].sort(), componentIds: sorted(components), connectionIds: sorted(connections), requirementIds: sorted(requirements), factIds: sorted(facts), sourceIds: sorted(sources), protectedComponentIds: bundle.kit.components.filter(component => component.owned).map(component => component.id).sort(), explanation: `${components.size} connected pieces and ${requirements.size} requirements are rechecked. Owned equipment and the original hard brief stay fixed.` };
}
export function semanticCause(input: { tenantId: string; namespace: string; kitId: string; baseGraphHash: string; itemId: string; productId: string; selectedOptions: { name: string; value: string }[]; domain: string; condition: string }) {
  return hash({ ...input, selectedOptions: [...input.selectedOptions].sort((a, b) => a.name.localeCompare(b.name)), domain: input.domain.toLowerCase() });
}
export function preservedIntent(before: RepairBundle, after: RepairBundle): { preserved: boolean; reason: string } {
  if (hash(before.kit.goal) !== hash(after.kit.goal)) return { preserved: false, reason: "The original brief and hard requirements changed." };
  const ownedBefore = before.kit.components.filter(component => component.owned);
  for (const component of ownedBefore) {
    const current = after.kit.components.find(value => value.id === component.id);
    if (!current || hash(component) !== hash(current)) return { preserved: false, reason: "Owned equipment, its identity or its settings changed." };
  }
  if (after.kit.components.some(component => component.owned && !ownedBefore.some(original => original.id === component.id))) return { preserved: false, reason: "This change invents ownership of a new component." };
  return { preserved: true, reason: "The full brief and owned equipment are preserved." };
}
