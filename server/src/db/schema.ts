import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

// NOTE: The `embedding vector(1024)` columns on moments and segments require
// the pgvector extension. Enable it on the Neon database (CREATE EXTENSION
// IF NOT EXISTS vector) before running the generated migration. The 1024
// width is set by voyage-4 (Voyage's 4-series default, no truncation). Per
// AD #13, all voyage-4-series models share this space and are cross-
// compatible for retrieval, so upgrading model within the series does not
// require a re-embed. Changing series (or vendors) does.

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 256 }).notNull(),
    slug: varchar("slug", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    slugIdx: uniqueIndex("accounts_slug_idx").on(t.slug),
  }),
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 256 }),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountEmailIdx: uniqueIndex("people_account_email_idx").on(
      t.accountId,
      t.email,
    ),
  }),
);

// One row per connected OAuth grant (SAA-115) — not one row per calendar.
// That distinction wasn't obvious until the first real connect: a single
// grant on jd@quorom.io can see other calendars too (jd@leadiq.com, shared
// in), and the matcher needs to search all of them, not just the one the
// grant is keyed on. calendar_email stays the grant's own identity
// (primary calendar / who consented); searched_calendar_ids is the actual
// list of calendars a match searches, computed once at connect time from
// calendarList (see lib/google-calendar.ts's selectSearchableCalendars)
// rather than recomputed on every match — an extra Calendar API call per
// capture for a list that only changes when sharing changes. A truly
// separate account (a second OAuth grant, e.g. someone whose calendar
// can't be shared into this one) is still a second row.
//
// Tokens are encrypted at rest (lib/crypto.ts) — the open question the
// 2026-09-16 design comment on SAA-115 left undecided, resolved here rather
// than defaulted: a live table full of plaintext long-lived Google refresh
// tokens is expensive to fix after the fact, and encrypting from the first
// row is not.
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull().default("google"),
    calendarEmail: varchar("calendar_email", { length: 320 }).notNull(),
    // AES-256-GCM ciphertext (lib/crypto.ts), never the raw token.
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    scope: varchar("scope", { length: 256 }),
    // Calendars this grant is authorized to search, by id — computed at
    // connect time from calendarList, filtered to accessRole in
    // (owner, writer, reader) and excluding Google's own meta-calendars
    // (holiday/contacts/etc.) and freeBusyReader entries (no event detail
    // visible, so they could never produce a usable match). Nullable only
    // for a row written before this column existed; matchCaptureToCalendar
    // treats null/empty the same as "nothing to search".
    searchedCalendarIds: text("searched_calendar_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountEmailIdx: uniqueIndex("calendar_connections_account_email_idx").on(
      t.accountId,
      t.calendarEmail,
    ),
  }),
);

export const recordings = pgTable(
  "recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 128 }),
    title: varchar("title", { length: 512 }),
    source: varchar("source", { length: 64 }),
    sourceId: varchar("source_id", { length: 256 }),
    // Google's id shared by every instance of a recurring series (SAA-115
    // decision 4). Stored rather than the recurrence rule itself — this
    // gives a consumer the thread directly with no rule parsing.
    recurringEventId: varchar("recurring_event_id", { length: 256 }),
    mediaUrl: text("media_url"),
    durationSec: doublePrecision("duration_sec"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    meetingKind: varchar("meeting_kind", { length: 32 }),
    // Personal-vs-work classification (SAA-153) — deliberately a separate
    // column from meeting_kind rather than an overload of it: "kind of
    // meeting" and "personal versus work" are not the same axis, and
    // meeting_kind is null on every self-capture already. Null here means
    // unclassified, not "work" — search_moments' default-scope filter
    // treats null as work for now (see moments.ts), since almost every
    // existing recording predates this column and defaulting unclassified
    // to invisible would make the common case regress the day this ships.
    // Source of truth going forward is the identity-prompt answer at stop
    // (settled in the issue; the recorder-side prompt UI itself is not
    // part of this change).
    scope: varchar("scope", { length: 16 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountIdx: index("recordings_account_idx").on(t.accountId),
    sourceIdx: index("recordings_source_idx").on(t.source, t.sourceId),
    slugIdx: uniqueIndex("recordings_slug_idx").on(t.slug),
    scopeValid: check("recordings_scope_valid", sql`${t.scope} IN ('work', 'personal')`),
  }),
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }),
    language: varchar("language", { length: 16 }),
    text: text("text"),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recordingIdx: index("transcripts_recording_idx").on(t.recordingId),
  }),
);

export const speakers = pgTable(
  "speakers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    label: varchar("label", { length: 128 }),
    displayName: varchar("display_name", { length: 256 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recordingIdx: index("speakers_recording_idx").on(t.recordingId),
  }),
);

export const segments = pgTable(
  "segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    speakerId: uuid("speaker_id").references(() => speakers.id, {
      onDelete: "set null",
    }),
    startSec: doublePrecision("start_sec").notNull(),
    endSec: doublePrecision("end_sec").notNull(),
    text: text("text").notNull(),
    orderIndex: integer("order_index").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountIdx: index("segments_account_idx").on(t.accountId),
    recordingIdx: index("segments_recording_idx").on(t.recordingId),
    transcriptIdx: index("segments_transcript_idx").on(t.transcriptId),
    transcriptOrderIdx: uniqueIndex("segments_transcript_order_idx").on(
      t.transcriptId,
      t.orderIndex,
    ),
    embeddingIdx: index("segments_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const moments = pgTable(
  "moments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 64 }).notNull(),
    title: varchar("title", { length: 512 }),
    summary: text("summary"),
    startSec: doublePrecision("start_sec").notNull(),
    endSec: doublePrecision("end_sec").notNull(),
    score: doublePrecision("score"),
    embedding: vector("embedding", { dimensions: 1024 }),
    // Which model produced this row's embedding. Nullable — a row with a
    // null embedding also has a null model, and vice versa. Per AD #13,
    // model version is state: this column lets a re-embed sweep target
    // rows on a specific old model, and lets the search path know which
    // series (and therefore which query embedder) the vector belongs to.
    embeddingModel: varchar("embedding_model", { length: 64 }),
    // Flag for candid commentary about a named colleague's performance,
    // as distinct from decisions, topics, or initiatives. Set at extraction
    // time so eventual access work (Phase 4) keys off an existing column
    // instead of reclassifying accumulated moments. Per SAA-66.
    isPersonnelAssessment: boolean("is_personnel_assessment")
      .notNull()
      .default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountIdx: index("moments_account_idx").on(t.accountId),
    recordingIdx: index("moments_recording_idx").on(t.recordingId),
    embeddingIdx: index("moments_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const clips = pgTable(
  "clips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    momentId: uuid("moment_id").references(() => moments.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => people.id, {
      onDelete: "set null",
    }),
    slug: varchar("slug", { length: 128 }),
    title: varchar("title", { length: 512 }),
    description: text("description"),
    startSec: doublePrecision("start_sec").notNull(),
    endSec: doublePrecision("end_sec").notNull(),
    mediaUrl: text("media_url"),
    thumbnailUrl: text("thumbnail_url"),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    accountIdx: index("clips_account_idx").on(t.accountId),
    recordingIdx: index("clips_recording_idx").on(t.recordingId),
    slugIdx: uniqueIndex("clips_slug_idx").on(t.slug),
  }),
);

export const attendees = pgTable(
  "attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 256 }),
    role: varchar("role", { length: 64 }),
    domainKind: varchar("domain_kind", { length: 32 }),
    isHost: boolean("is_host").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recordingIdx: index("attendees_recording_idx").on(t.recordingId),
  }),
);

// A calendar invitee (SAA-115 decision 3), deliberately separate from
// `attendees`: an invitee who did not join is not an attendee, and the
// first real event matched during the dry run showed why — the invite
// list is not the attendance list even on a call that genuinely matches.
//
// email is NOT NULL, unlike attendees.email — deliberately, so this table
// does not inherit SAA-128's still-open question (what makes a row unique
// when the key field can be null). A calendar invitee always has an email;
// a Google attendee object with none (a resource/room calendar, or a
// malformed entry) is not inserted here at all, never written with a null.
// That makes UNIQUE(recording_id, email) safe as a plain index — no
// null-collapsing case to design around — and it is also the ON CONFLICT
// target applyCalendarMatch upserts against.
export const invitees = pgTable(
  "invitees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    // Linked only to a person row that already exists (by email) — never
    // created from an invitee. An invited-but-declined/never-joined person
    // must not become a resolvable identity in the known-names picker
    // (SAA-180), which already degrades with every person added; that
    // signal should keep coming from actual attendance, not an invite.
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 256 }),
    // Google's own value: accepted / declined / tentative / needsAction.
    responseStatus: varchar("response_status", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recordingEmailIdx: uniqueIndex("invitees_recording_email_idx").on(
      t.recordingId,
      t.email,
    ),
  }),
);

// A share points to either a clip OR a recording (not both, not neither).
// The `shares_target_exactly_one` check constraint below enforces XOR:
// exactly one of clip_id or recording_id must be non-null.
export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clipId: uuid("clip_id").references(() => clips.id, {
      onDelete: "cascade",
    }),
    recordingId: uuid("recording_id").references(() => recordings.id, {
      onDelete: "cascade",
    }),
    createdBy: uuid("created_by").references(() => people.id, {
      onDelete: "set null",
    }),
    token: varchar("token", { length: 128 }).notNull(),
    visibility: varchar("visibility", { length: 32 }).notNull().default("link"),
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tokenIdx: uniqueIndex("shares_token_idx").on(t.token),
    clipIdx: index("shares_clip_idx").on(t.clipId),
    recordingIdx: index("shares_recording_idx").on(t.recordingId),
    targetExactlyOne: check(
      "shares_target_exactly_one",
      sql`(${t.clipId} IS NOT NULL) <> (${t.recordingId} IS NOT NULL)`,
    ),
  }),
);

export const accountsRelations = relations(accounts, ({ many }) => ({
  people: many(people),
  recordings: many(recordings),
  segments: many(segments),
  moments: many(moments),
  clips: many(clips),
  shares: many(shares),
  calendarConnections: many(calendarConnections),
}));

export const calendarConnectionsRelations = relations(calendarConnections, ({ one }) => ({
  account: one(accounts, {
    fields: [calendarConnections.accountId],
    references: [accounts.id],
  }),
}));

export const peopleRelations = relations(people, ({ one, many }) => ({
  account: one(accounts, {
    fields: [people.accountId],
    references: [accounts.id],
  }),
  attendees: many(attendees),
  invitees: many(invitees),
  speakers: many(speakers),
}));

export const recordingsRelations = relations(recordings, ({ one, many }) => ({
  account: one(accounts, {
    fields: [recordings.accountId],
    references: [accounts.id],
  }),
  transcripts: many(transcripts),
  speakers: many(speakers),
  moments: many(moments),
  clips: many(clips),
  attendees: many(attendees),
  invitees: many(invitees),
  shares: many(shares),
}));

export const transcriptsRelations = relations(transcripts, ({ one, many }) => ({
  recording: one(recordings, {
    fields: [transcripts.recordingId],
    references: [recordings.id],
  }),
  segments: many(segments),
}));

export const segmentsRelations = relations(segments, ({ one }) => ({
  account: one(accounts, {
    fields: [segments.accountId],
    references: [accounts.id],
  }),
  recording: one(recordings, {
    fields: [segments.recordingId],
    references: [recordings.id],
  }),
  transcript: one(transcripts, {
    fields: [segments.transcriptId],
    references: [transcripts.id],
  }),
  speaker: one(speakers, {
    fields: [segments.speakerId],
    references: [speakers.id],
  }),
}));

export const speakersRelations = relations(speakers, ({ one, many }) => ({
  recording: one(recordings, {
    fields: [speakers.recordingId],
    references: [recordings.id],
  }),
  person: one(people, {
    fields: [speakers.personId],
    references: [people.id],
  }),
  segments: many(segments),
}));

export const momentsRelations = relations(moments, ({ one, many }) => ({
  account: one(accounts, {
    fields: [moments.accountId],
    references: [accounts.id],
  }),
  recording: one(recordings, {
    fields: [moments.recordingId],
    references: [recordings.id],
  }),
  clips: many(clips),
}));

export const clipsRelations = relations(clips, ({ one, many }) => ({
  account: one(accounts, {
    fields: [clips.accountId],
    references: [accounts.id],
  }),
  recording: one(recordings, {
    fields: [clips.recordingId],
    references: [recordings.id],
  }),
  moment: one(moments, {
    fields: [clips.momentId],
    references: [moments.id],
  }),
  creator: one(people, {
    fields: [clips.createdBy],
    references: [people.id],
  }),
  shares: many(shares),
}));

export const attendeesRelations = relations(attendees, ({ one }) => ({
  recording: one(recordings, {
    fields: [attendees.recordingId],
    references: [recordings.id],
  }),
  person: one(people, {
    fields: [attendees.personId],
    references: [people.id],
  }),
}));

export const inviteesRelations = relations(invitees, ({ one }) => ({
  recording: one(recordings, {
    fields: [invitees.recordingId],
    references: [recordings.id],
  }),
  person: one(people, {
    fields: [invitees.personId],
    references: [people.id],
  }),
}));

export const sharesRelations = relations(shares, ({ one }) => ({
  account: one(accounts, {
    fields: [shares.accountId],
    references: [accounts.id],
  }),
  clip: one(clips, {
    fields: [shares.clipId],
    references: [clips.id],
  }),
  recording: one(recordings, {
    fields: [shares.recordingId],
    references: [recordings.id],
  }),
  creator: one(people, {
    fields: [shares.createdBy],
    references: [people.id],
  }),
}));
