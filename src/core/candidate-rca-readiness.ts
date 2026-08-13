let sessionsReady = false;

export function candidateRcaSessionsReady(): boolean {
  return sessionsReady;
}

export function markCandidateRcaSessionsReady(): void {
  sessionsReady = true;
}
