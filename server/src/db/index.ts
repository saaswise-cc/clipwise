import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// pg pool emits 'error' on idle clients whose socket dies (Neon suspend, TCP
// keepalive kill, TLS renegotiation). Without a listener these become
// uncaughtException and kill the process — see SAA-69. The pool replaces the
// bad client on the next query, so logging is enough.
pool.on("error", (err) => {
  console.error("pg pool error on idle client:", err);
});

// SAA-69 only covers clients sitting idle in the pool. A client that has been
// checked out — which is what drizzle's db.transaction() does for the life of
// a transaction (pool.connect(), per node_modules/drizzle-orm/node-postgres/
// session.js) — has its idle-error listener removed by pg-pool the moment
// it's handed out (pg-pool/index.js: _acquireClient) and gets nothing back
// until it's released. An 'error' event with no listener on a checked-out
// client throws synchronously and kills the process exactly like the idle
// case did, just mid-write instead of mid-idle: SAA-155, 2026-09-02T15-40-29Z,
// "Connection terminated unexpectedly" while ingest was mid-transaction.
//
// pg still rejects the query that was in flight when the socket died
// (Client._errorAllQueries in pg/lib/client.js, scheduled via
// process.nextTick) regardless of whether a listener is attached — the crash
// is purely the listener-less emit(), not a hole in error propagation. So a
// listener that only logs is enough to turn the crash into the same rejected-
// promise path every other ingest failure already takes: it surfaces as a
// normal `await` rejection inside db.transaction(), which propagates through
// ingestTranscript() to run-capture.ts's per-step try/catch, which marks the
// step failed with the error and lets the process exit cleanly (verified
// against the 2026-09-02T18-19-13Z capture, where a connection failure at a
// different point — pool.connect() itself rejecting on a DNS lookup — took
// this exact path with no crash).
//
// 'acquire' fires on every checkout, new or reused; 'release' fires when it
// goes back. Paired so the listener doesn't accumulate on a client reused
// across many checkouts over its lifetime.
function logCheckedOutClientError(err: Error): void {
  console.error("pg client error while checked out:", err);
}
pool.on("acquire", (client) => {
  client.on("error", logCheckedOutClientError);
});
pool.on("release", (_err, client) => {
  client.removeListener("error", logCheckedOutClientError);
});

export const db = drizzle(pool, { schema });
export { schema };
