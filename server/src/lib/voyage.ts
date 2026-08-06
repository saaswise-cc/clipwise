// Thin wrapper for Voyage AI's embeddings endpoint.
//
// AD #13 fixes the model to voyage-4 at 1024 dimensions (the model default,
// no truncation) and requires input_type=document at write time and
// input_type=query at search time — the two call sites MUST pass different
// values. Voyage prepends different internal prompts for each, and getting
// it wrong produces a valid-looking vector that retrieves plausible-but-
// worse results, with no error and no visible symptom.
//
// The template joining title and summary is a moment-specific concern and
// lives in the extraction/backfill code, not here.

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-4";

// Voyage per-request limits (as of 2026-08). The list ceiling is 1000
// inputs; the token ceiling varies by model and is 320K for voyage-4.
// For short moment text the token ceiling binds first — a batch of 1000
// average-length moment summaries would blow the token limit long before
// hitting the input count. Chunking below enforces both, so callers can
// pass any-size arrays and let embed() decide the split.
const VOYAGE_MAX_INPUTS = 1000;
const VOYAGE_MAX_TOKENS_PER_REQ = 320_000;
// Rough estimator: ~4 chars/token for English. Deliberately conservative
// against the true ceiling so the estimate can be off by 15% without
// producing a request that fails at the API boundary.
const CHARS_PER_TOKEN = 4;
const CHAR_BUDGET_PER_REQ = Math.floor(VOYAGE_MAX_TOKENS_PER_REQ * CHARS_PER_TOKEN * 0.85);

export type VoyageInputType = "document" | "query";

export function currentEmbeddingModel(): string {
  return DEFAULT_MODEL;
}

// Serialise a JS number array into pgvector's text form: "[a,b,c,...]".
// Used when passing a query vector as a bound parameter to a distance
// operator — drizzle's cosineDistance accepts either number[] or a string
// in this shape; using the string form keeps SQL logs from ballooning
// with 1024 bound-parameter placeholders.
export function toPgVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// Embed a batch of texts. Chunks internally by both input count and
// estimated tokens so callers can pass any-size arrays without knowing
// Voyage's per-request ceilings. Throws on API errors so callers can
// decide whether to record and continue or bubble.
export async function embed(
  texts: string[],
  inputType: VoyageInputType,
  model: string = DEFAULT_MODEL,
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY not set");
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (const chunk of chunkForVoyage(texts)) {
    const vectors = await embedOne(chunk, inputType, model, apiKey);
    for (const v of vectors) out.push(v);
  }
  return out;
}

async function embedOne(
  texts: string[],
  inputType: VoyageInputType,
  model: string,
  apiKey: string,
): Promise<number[][]> {
  const res = await fetch(VOYAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model, input_type: inputType }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`voyage embed ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

function* chunkForVoyage(texts: string[]): Generator<string[]> {
  let batch: string[] = [];
  let batchChars = 0;
  for (const t of texts) {
    const wouldOverflowChars = batchChars + t.length > CHAR_BUDGET_PER_REQ;
    const wouldOverflowInputs = batch.length >= VOYAGE_MAX_INPUTS;
    if (batch.length > 0 && (wouldOverflowChars || wouldOverflowInputs)) {
      yield batch;
      batch = [];
      batchChars = 0;
    }
    batch.push(t);
    batchChars += t.length;
  }
  if (batch.length > 0) yield batch;
}

// Text that gets embedded for a moment. Fixed template per AD #13 — any
// change to it invalidates every existing vector as thoroughly as
// changing the model does, and must be paired with a re-embed sweep and
// an entry in Architecture Decisions.
//
// Returns null when both title and summary are absent — embedding "\n\n"
// produces a meaningless vector, and leaving the row unembedded surfaces
// the situation in the sweep's counts rather than papering it over.
export function momentEmbedText(
  title: string | null | undefined,
  summary: string | null | undefined,
): string | null {
  const t = (title ?? "").trim();
  const s = (summary ?? "").trim();
  if (!t && !s) return null;
  return `${title ?? ""}\n\n${summary ?? ""}`;
}
