import { hash } from "../../packages/compatibility";
import { RESEARCH_POLICY, type ResearchDetail } from "../../packages/research-notebook/contracts";
import { summarizeResearch } from "../../packages/research-notebook/policy";
import { researchFail, type ResearchAccess } from "./research-notebook-authority";
import { researchError, researchHeaders } from "./research-notebook-http";
import { researchNotebookHome } from "./research-notebook";

export function researchExport(detail: ResearchDetail, redacted: boolean) {
  const study = detail.study, binding = study.binding;
  const summary = summarizeResearch(study, detail.protocol, detail.protocols, detail.participants, detail.attempts, redacted);
  summary.cohorts = summary.cohorts.filter(cohort => cohort.protocolId === detail.protocol.id);
  const body = redacted ? {
    schema: "worldkit.research-aggregate.1", policy: RESEARCH_POLICY, studyId: study.id, studyVersion: study.version, studyHash: study.hash,
    sourceMode: study.mode, phase: study.phase, sealedAt: study.sealedAt,
    binding: { kind: binding.kind, subjectId: binding.subjectId, revisionId: binding.revisionId, graphHash: binding.graphHash, bindingHash: binding.hash, certificateHash: binding.certificateHash, ruleVersion: binding.ruleVersion, graphSource: binding.graphSource },
    protocol: { id: detail.protocol.id, number: detail.protocol.number, hash: detail.protocol.hash, tasks: detail.protocol.tasks.map(task => ({ id: task.id, hash: hash(task) })) },
    summary: { ...summary, cohorts: summary.cohorts.map(cohort => ({ ...cohort, taskTitle: `Task ${detail.protocol.tasks.findIndex(task => task.id === cohort.taskId) + 1}` })) },
    redactions: ["Only aggregate records permitted by both current and original private/anonymous-public consent are included.", "No individual participant or attempt rows, pseudonyms, responses, notes, consent references, study title/objective or free-form task text are exported.", "This is a download, not automatic publication. No independent identity, consent or human-performance verification is claimed."],
    existingCertificateChanged: false,
  } : { schema: "worldkit.research-private.1", policy: RESEARCH_POLICY, study, protocol: detail.protocol, currentSource: detail.currentSource,
    participants: detail.participants, attempts: detail.attempts.filter(attempt => attempt.protocolId === detail.protocol.id), summary, history: detail.history,
    privacy: "Withdrawn, expired or unpermitted participant text is withheld even in a private owner export. Original fingerprints and categorical audit states remain.", existingCertificateChanged: false };
  return { ...body, exportHash: hash(body) };
}
export function researchCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Quoting CSV alone does not stop spreadsheet formula execution.
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function researchCsv(detail: ResearchDetail, redacted: boolean): string {
  const rows: unknown[][] = [];
  if (redacted) {
    rows.push(["source_mode", "protocol_number", "protocol_hash", "task_id", "eligible_participants", "success", "partial", "failure", "abandoned", "unknown", "pending", "denominator", "unaided_success", "varied_system_attempts", "missing_source_attempts", "scope"]);
    const summary = summarizeResearch(detail.study, detail.protocol, detail.protocols, detail.participants, detail.attempts, true);
    for (const cohort of summary.cohorts.filter(value => value.protocolId === detail.protocol.id)) rows.push([cohort.mode, cohort.protocolNumber, cohort.protocolHash, cohort.taskId, cohort.eligibleParticipants, cohort.counts.success, cohort.counts.partial, cohort.counts.failure, cohort.counts.abandoned, cohort.counts.unknown, cohort.counts.pending, cohort.counts.denominator, cohort.counts.unaidedSuccess, cohort.variedSystemAttempts, cohort.missingSourceAttempts, "Current and original aggregate consent; first attempt only; no independently verified people or performance"]);
  } else {
    rows.push(["source_mode", "protocol_hash", "task_id", "participant_id", "pseudonym", "attempt_id", "attempt_number", "first_attempt", "retry_of", "consent_hash", "started_at", "finished_at", "recorded_interval_ms", "completion_kind", "outcome", "assistance", "comprehension", "eligible_for_private_summary", "exclusion_reason", "start_revision", "start_graph_hash", "outcome_revision", "outcome_graph_hash", "observed_note", "response"]);
    for (const attempt of detail.attempts.filter(value => value.protocolId === detail.protocol.id)) {
      const participant = detail.participants.find(value => value.id === attempt.participantId);
      rows.push([attempt.mode, attempt.protocolHash, attempt.task.id, attempt.participantId, participant?.pseudonym, attempt.id, attempt.number, attempt.firstAttempt, attempt.retryOf, attempt.consentHash, attempt.startedAt, attempt.finishedAt, attempt.recordedIntervalMs, attempt.completionKind, attempt.result?.outcome, attempt.result?.assistance, attempt.result?.comprehension, attempt.eligibleForPrivateSummary, attempt.exclusionReason, attempt.startSource.revisionId, attempt.startSource.graphHash, attempt.outcomeSource?.revisionId, attempt.outcomeSource?.graphHash, attempt.result?.observedNote, attempt.result?.response]);
    }
  }
  return rows.map(row => row.map(researchCsvCell).join(",")).join("\r\n") + "\r\n";
}
export async function researchExportResponse(request: Request, access: ResearchAccess) {
  try {
    if (request.method !== "GET") researchFail("Research exports are read with GET.", "invalid_request", 405);
    const url = new URL(request.url), view = url.searchParams.get("view") ?? "redacted", format = url.searchParams.get("format") ?? "json";
    if (!["private", "redacted"].includes(view) || !["json", "csv"].includes(format)) researchFail("Choose a private or redacted JSON/CSV export.", "invalid_request");
    const home = await researchNotebookHome(access, url.searchParams.get("studyId") ?? undefined, url.searchParams.get("protocolId") ?? undefined);
    if (!home.selected) researchFail("Select a study to export.", "not_found");
    const headers = { ...researchHeaders, "Content-Disposition": `attachment; filename="worldkit-research-protocol-${home.selected.protocol.number}-${view}.${format}"` };
    return format === "json" ? Response.json(researchExport(home.selected, view === "redacted"), { headers }) : new Response(researchCsv(home.selected, view === "redacted"), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  } catch (error) { return researchError(error); }
}
