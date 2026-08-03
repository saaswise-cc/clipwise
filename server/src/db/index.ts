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

export const db = drizzle(pool, { schema });
export { schema };
