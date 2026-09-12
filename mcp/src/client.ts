export interface ClipwiseConfig {
  serverUrl: string;
  accountId: string;
}

export function loadConfig(): ClipwiseConfig {
  const serverUrl = process.env.CLIPWISE_SERVER_URL;
  const accountId = process.env.CLIPWISE_ACCOUNT_ID;
  if (!serverUrl) throw new Error("CLIPWISE_SERVER_URL environment variable is required");
  if (!accountId) throw new Error("CLIPWISE_ACCOUNT_ID environment variable is required");
  return { serverUrl: serverUrl.replace(/\/$/, ""), accountId };
}

export class ClipwiseClient {
  constructor(private readonly config: ClipwiseConfig) {}

  private async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.config.serverUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`clipwise ${res.status} ${res.statusText}: ${body}`);
    }
    return (await res.json()) as T;
  }

  searchMoments(params: {
    q?: string;
    semanticQ?: string;
    recordingId?: string;
    kind?: string;
    attendee?: string;
    limit?: number;
    scope?: "work" | "personal" | "all";
    // Recording-level enumeration (SAA-85) instead of a moment search —
    // mutually exclusive with q/semanticQ. Changes the response shape from
    // `moments` to `recordings`; see SearchMomentsResult below.
    index?: boolean;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<SearchMomentsResult> {
    return this.get(`/accounts/${this.config.accountId}/moments`, {
      q: params.q,
      semantic_q: params.semanticQ,
      recordingId: params.recordingId,
      kind: params.kind,
      attendee: params.attendee,
      limit: params.limit?.toString(),
      scope: params.scope,
      index: params.index ? "true" : undefined,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
  }

  async getRecording(
    recordingId: string,
  ): Promise<{ recording: RecordingRecord; attendees: AttendeeRecord[] }> {
    return this.get(`/accounts/${this.config.accountId}/recordings/${recordingId}`);
  }

  async getTranscript(recordingId: string): Promise<TranscriptResponse> {
    return this.get(`/recordings/${recordingId}/transcript`);
  }
}

export interface MomentSummary {
  id: string;
  recordingId: string;
  kind: string;
  title: string | null;
  summary: string | null;
  startSec: number;
  endSec: number;
  score: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  recordingTitle: string | null;
  recordingSlug: string | null;
  // Present only on semantic-path results. Cosine similarity in [-1, 1];
  // 1 is identical. See AD #13 on why the raw score is surfaced rather
  // than filtered with a threshold.
  similarity?: number;
  // Present only on semantic-path results. Identifies which embedding
  // model produced this row's vector; useful when the corpus is in
  // transition across a model change.
  embeddingModel?: string | null;
}

// One recording in an index (SAA-85) result — date, attendees, duration and
// moment counts by kind, no moment content. `momentCounts` keys are
// whatever `kind` values are actually present on this recording (e.g.
// "decision", "commitment", "observation"); a kind with zero moments is
// simply absent from the object rather than present as 0.
export interface RecordingIndexEntry {
  id: string;
  title: string | null;
  startedAt: string | null;
  durationSec: number | null;
  // Guests, not the host — matches what the identity prompt already asks
  // for ("who was on this call with") and what search_moments' own
  // attendee filter matches against.
  attendees: string[];
  momentCounts: Record<string, number>;
  totalMoments: number;
}

// Common to both response shapes search_moments can return.
interface SearchMomentsEnvelope {
  totalMatches: number;
  truncated: boolean;
  scope: "work" | "personal" | "all";
  scopeDefaulted: boolean;
}

export type SearchMomentsResult =
  | (SearchMomentsEnvelope & { moments: MomentSummary[] })
  | (SearchMomentsEnvelope & { recordings: RecordingIndexEntry[] });

export interface RecordingRecord {
  id: string;
  accountId: string;
  title: string | null;
  slug: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  meetingKind: string | null;
}

export interface AttendeeRecord {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  domainKind: string | null;
  isHost: boolean;
}

export interface TranscriptResponse {
  transcript: {
    id: string;
    provider: string | null;
    language: string | null;
    status: string;
  } | null;
  segments: Array<{
    id: string;
    startSec: number;
    endSec: number;
    text: string;
    speakerLabel: string | null;
    speakerDisplayName: string | null;
  }>;
}
