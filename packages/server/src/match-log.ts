import type { MatchReport } from "@agentproxy/shared";

/** A match report, with when the server received it (epoch ms). */
export interface LoggedMatch extends MatchReport {
  at: number;
}

export interface MatchQuery {
  /** Only matches answered by this mock. */
  ruleId?: string;
  /** Only matches received at or after this time (epoch ms). */
  since?: number;
}

/** Which requests the mocks answered, so the agent can check its mocks took effect. */
export interface MatchLog {
  record(match: MatchReport): void;
  /** The matching entries, oldest first. */
  query(filter?: MatchQuery): LoggedMatch[];
}

export const DEFAULT_MAX_MATCHES = 500;

export function createMatchLog({ now = Date.now, max = DEFAULT_MAX_MATCHES } = {}): MatchLog {
  const entries: LoggedMatch[] = [];

  return {
    record(match) {
      entries.push({ ...match, at: now() });
      if (entries.length > max) entries.splice(0, entries.length - max);
    },

    query({ ruleId, since } = {}) {
      return entries.filter(
        (entry) =>
          (ruleId === undefined || entry.ruleId === ruleId) &&
          (since === undefined || entry.at >= since),
      );
    },
  };
}
