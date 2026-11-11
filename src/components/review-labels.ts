import type { EngineeringClaim, ProposalContent } from "../../packages/engineering-review/contracts";

const names: Record<string, string> = {
  modelIdentity: "Model and variant",
  independentChannels: "Independent recording channels",
  simultaneousUsbRecording: "Record while streaming via USB",
  connector: "Connector",
  direction: "Signal direction",
  signal: "Signal type",
  protocols: "Supported protocols",
  channels: "Channel count",
  power: "Power requirement",
  resource: "Shared resource",
};

export function reviewClaimLabel(claim: EngineeringClaim, content: ProposalContent): string {
  const predicate = claim.predicate.replace(/^port:/, "");
  const label = names[predicate] ?? predicate.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, value => value.toUpperCase());
  const port = content.ports.find(port => Object.values(port.fields).includes(claim.id));
  return port ? `${port.label} · ${label}` : label;
}

export function reviewTargetLabel(content: ProposalContent, id: string, fallback: string): string {
  const claim = content.claims.find(claim => claim.id === id);
  return claim ? reviewClaimLabel(claim, content) : fallback;
}

const bindingChanges: Record<string, string> = {
  kitId: "The kit has changed.",
  revisionId: "A newer kit revision is current.",
  graphHash: "The kit’s equipment connections have changed.",
  profileId: "The equipment profile has changed.",
  profileHeadId: "A newer equipment profile is current.",
  candidateId: "The source candidate has changed.",
  candidateHash: "The source candidate has changed.",
  documentId: "The source document has changed.",
  sourceHash: "The source document has changed.",
  textHash: "The source text has changed.",
  sourceHeadVersion: "A newer source document is current.",
  assetId: "The equipment image has changed.",
  assetHash: "The equipment image has changed.",
  cropHash: "The approved image crop has changed.",
  draftId: "The source draft has changed.",
  draftHash: "The source draft has changed.",
};

export function reviewStaleMessage(message: string): string {
  const separator = message.indexOf(": ");
  const change = separator < 0 ? undefined : bindingChanges[message.slice(0, separator)];
  return change ? `${change} Create a fresh edition before making a decision.` : message;
}
