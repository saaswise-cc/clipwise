// Embedding sweep — fills nulls in the searchable moment set.
//
// Same job as the failure-recovery pass after an extraction and the
// re-embed pass after a model change (AD #13): scan for embedding IS NULL
// within the current-extraction-run + hand-curated scope (the same set
// search_moments returns), batch-embed with input_type=document, and
// UPDATE embedding + embedding_model per row. Rows from superseded
// extraction runs are deliberately left alone — search never touches
// them, so embedding them would burn tokens for nothing.
//
// This module is the ONLY place that writes moments.embedding. Extract
// calls it per-span after inserting rows; the standalone sweep re-uses
// it for the corpus-wide backfill and the future re-embed job.

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  currentEmbeddingModel,
  embed,
  momentEmbedText,
  toPgVectorLiteral,
} from "../lib/voyage.js";

// Chunk size for fetch + transaction, not for Voyage — voyage.ts chunks
// internally against the API's 1000-input / 320K-token ceilings. This is
// a memory/rollback-blast-radius knob: a chunk that fails at DB write
// time rolls back that many pending UPDATEs, not the whole sweep.
const CHUNK_SIZE = 100;

export type EmbedResult = {
  // Vectors were written to these many rows and the sweep would report
  // them as complete.
  embedded: number;
  // API error or DB error on these rows; embedding still null, sweep
  // will retry them on the next pass.
  failed: number;
  // Rows with both title and summary empty. Not embeddable — sweeping
  // them again does nothing. Counted separately so the "still null"
  // number after a sweep decomposes cleanly.
  skipped: number;
};

// Embed a specific set of moments by id. Used by extract.ts to fill in
// the vectors for a span's freshly-inserted rows without touching
// anything outside the run. Never throws — an API or DB failure leaves
// the rows unembedded for the sweep to retry, which is what makes the
// extraction path robust to Voyage outages per AD #13.
export async function embedMomentsByIds(ids: string[]): Promise<EmbedResult> {
  if (ids.length === 0) return { embedded: 0, failed: 0, skipped: 0 };
  let embedded = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const rows = await db
      .select({
        id: schema.moments.id,
        title: schema.moments.title,
        summary: schema.moments.summary,
      })
      .from(schema.moments)
      .where(inArray(schema.moments.id, chunk));
    if (rows.length === 0) continue;

    // Build id/text pairs together so filtering nulls can't drift the
    // two arrays apart. If we filtered texts and ids in separate passes
    // and one pass had a bug, applyEmbeddings' length check would still
    // pass while writing vectors to the wrong rows — no visible symptom.
    const pairs: { id: string; text: string }[] = [];
    for (const r of rows) {
      const text = momentEmbedText(r.title, r.summary);
      if (text === null) {
        skipped++;
        continue;
      }
      pairs.push({ id: r.id, text });
    }
    if (pairs.length === 0) continue;

    let vectors: number[][];
    try {
      vectors = await embed(pairs.map((p) => p.text), "document");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `embeddings: batch of ${pairs.length} failed at Voyage — leaving embedding null for sweep to retry (${msg})`,
      );
      failed += pairs.length;
      continue;
    }

    // DB write failures are caught the same way as API failures rather
    // than bubbled. The two paths were inconsistent before; making them
    // both retry-on-next-sweep matches the AD #13 stance that the sweep
    // and the failure-recovery pass are the same job. The counter only
    // moves after the transaction commits, so a rollback of the whole
    // chunk decrements nothing already counted.
    try {
      await applyEmbeddings(
        pairs.map((p) => p.id),
        vectors,
      );
      embedded += pairs.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `embeddings: batch of ${pairs.length} failed at DB write — leaving embedding null for sweep to retry (${msg})`,
      );
      failed += pairs.length;
    }
  }
  return { embedded, failed, skipped };
}

// Corpus-wide sweep: fill every null embedding in the searchable set.
// Matches the same scope predicate as search_moments (SAA-78) so the
// count of nulls after the sweep is exactly the count search sees, not
// the count on the raw table.
export async function backfillMissingEmbeddings(): Promise<EmbedResult & { scanned: number }> {
  const rows = await db
    .select({ id: schema.moments.id })
    .from(schema.moments)
    .innerJoin(
      schema.recordings,
      eq(schema.moments.recordingId, schema.recordings.id),
    )
    .where(
      and(
        isNull(schema.moments.embedding),
        sql`(${schema.moments.metadata}->>'collapsed_into') IS NULL`,
        or(
          sql`(${schema.moments.metadata}->>'source') = 'hand_curated'`,
          sql`(${schema.moments.metadata}->>'extraction_run') = (${schema.recordings.metadata}->>'current_extraction_run')`,
        ),
      ),
    );
  const ids = rows.map((r) => r.id);
  console.log(
    `embeddings: sweep — ${ids.length} moment(s) with null embedding in searchable scope`,
  );
  const result = await embedMomentsByIds(ids);
  return { scanned: ids.length, ...result };
}

// Write vectors + model to the DB. Kept private so the model column and
// the vector always move together — writing one without the other is a
// silent inconsistency and having a single writer makes that impossible.
async function applyEmbeddings(ids: string[], vectors: number[][]): Promise<void> {
  if (ids.length !== vectors.length) {
    throw new Error(`embeddings: id/vector count mismatch (${ids.length} vs ${vectors.length})`);
  }
  const model = currentEmbeddingModel();
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      const lit = toPgVectorLiteral(vectors[i]);
      await tx
        .update(schema.moments)
        .set({
          embedding: sql`${lit}::vector`,
          embeddingModel: model,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.moments.id, ids[i]));
    }
  });
}
