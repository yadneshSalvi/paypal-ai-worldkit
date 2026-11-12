import type { ResearchAttempt, ResearchConsentInput, ResearchCounts, ResearchParticipant, ResearchProtocol, ResearchStudy, ResearchSummary } from "./contracts";

export function researchConsentCurrent(consent: Pick<ResearchConsentInput, "privateResearch" | "grantedAt" | "expiresAt">, now = Date.now()) {
  return consent.privateResearch && Date.parse(consent.grantedAt) <= now && (!consent.expiresAt || Date.parse(consent.expiresAt) > now);
}
export function researchCounts(attempts: ResearchAttempt[], publicOnly = false): ResearchCounts {
  const counts: ResearchCounts = { success: 0, partial: 0, failure: 0, abandoned: 0, unknown: 0, pending: 0, excluded: 0, denominator: 0, unaidedSuccess: 0, assistance: { none: 0, prompted: 0, guided: 0, notRecorded: 0 }, comprehension: { correct: 0, incorrect: 0, uncertain: 0, notAssessed: 0 } };
  for (const attempt of attempts.filter(value => value.firstAttempt)) {
    if (!(publicOnly ? attempt.eligibleForPublicSummary : attempt.eligibleForPrivateSummary)) { counts.excluded++; continue; }
    if (!attempt.result) { counts.pending++; continue; }
    counts[attempt.result.outcome]++;
    if (attempt.result.outcome !== "unknown") counts.denominator++;
    if (attempt.result.outcome === "success" && attempt.result.assistance === "none") counts.unaidedSuccess++;
    counts.assistance[attempt.result.assistance === "not_recorded" ? "notRecorded" : attempt.result.assistance]++;
    counts.comprehension[attempt.result.comprehension === "not_assessed" ? "notAssessed" : attempt.result.comprehension]++;
  }
  return counts;
}
const varied = (attempt: ResearchAttempt) => [attempt.startSource, attempt.outcomeSource].some(source => source?.availability === "available" && !source.matchesStudyBinding);
const missing = (attempt: ResearchAttempt) => [attempt.startSource, attempt.outcomeSource].some(source => source?.availability === "missing");
export function summarizeResearch(study: ResearchStudy, protocol: ResearchProtocol, protocols: ResearchProtocol[], allParticipants: ResearchParticipant[], allAttempts: ResearchAttempt[], publicOnly = false): ResearchSummary {
  // Public exports do not reveal even counts for people who never permitted aggregate use.
  const participants = publicOnly ? allParticipants.filter(value => value.eligibleForPublicSummary) : allParticipants;
  const attempts = publicOnly ? allAttempts.filter(value => value.eligibleForPublicSummary) : allAttempts;
  const eligible = (value: ResearchParticipant | ResearchAttempt) => publicOnly ? value.eligibleForPublicSummary : value.eligibleForPrivateSummary;
  const current = participants.filter(eligible), selected = attempts.filter(value => value.protocolId === protocol.id), visible = selected.filter(eligible);
  return {
    protocolId: protocol.id, protocolHash: protocol.hash, basis: "first_attempt_per_participant_task_protocol",
    operatorReportedParticipants: study.mode === "operator_recorded" ? current.length : 0,
    sampleParticipants: study.mode === "sample" ? current.length : 0, independentlyVerifiedParticipants: 0,
    eligibleParticipants: current.length, publicAggregateEligibleParticipants: participants.filter(value => value.eligibleForPublicSummary).length,
    excludedParticipants: participants.length - current.length,
    variedSystemAttempts: visible.filter(varied).length, missingSourceAttempts: visible.filter(missing).length,
    counts: researchCounts(selected, publicOnly),
    allAttempts: { total: selected.length, first: selected.filter(value => value.firstAttempt).length, retries: selected.filter(value => !value.firstAttempt).length, running: selected.filter(value => value.state === "running").length, unknown: selected.filter(value => value.result?.outcome === "unknown").length, excluded: selected.filter(value => !eligible(value)).length },
    cohorts: protocols.flatMap(saved => saved.tasks.map(task => {
      const cohort = attempts.filter(value => value.protocolId === saved.id && value.task.id === task.id), observed = cohort.filter(eligible);
      return { protocolId: saved.id, protocolHash: saved.hash, protocolNumber: saved.number, taskId: task.id, taskTitle: task.title, mode: study.mode,
        eligibleParticipants: new Set(observed.map(value => value.participantId)).size, counts: researchCounts(cohort, publicOnly),
        variedSystemAttempts: observed.filter(varied).length, missingSourceAttempts: observed.filter(missing).length };
    })),
    limitations: [
      study.mode === "sample" ? "These fictional Sample participants and outcomes establish no real user-study result." : "Participants, consent, experience and outcomes are recorded by the operator; no identity, expertise or performance is independently verified.",
      "Only the first attempt for each participant, exact task and protocol enters the primary success denominator. Later retries preserve the original result.",
      "The denominator is success + partial + failure + abandoned. Unknown, pending and currently excluded attempts are shown separately.",
      "Current permission and the original consent at task start both apply. A new permission cannot expand an earlier permission or renew its original expiry.",
      "Recorded intervals use application timestamps. They do not independently measure a person's task time or establish a correct outcome.",
      "Actual current source identities are captured at start and outcome. Varied or missing sources are disclosed; protocol versions are never pooled.",
    ],
  };
}
