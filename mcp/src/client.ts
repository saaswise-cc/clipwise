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
  }): Promise<{ moments: MomentSummary[] }> {
    return this.get(`/accounts/${this.config.accountId}/moments`, {
      q: params.q,
      semantic_q: params.semanticQ,
      recordingId: params.recordingId,
      kind: params.kind,
      attendee: params.attendee,
      limit: params.limit?.toString(),
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
