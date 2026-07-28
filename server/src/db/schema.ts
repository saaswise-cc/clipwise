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
} from "drizzle-orm/pg-core";

// NOTE: pgvector embedding columns (e.g. transcripts.embedding, moments.embedding)
// will be added via a separate migration once the `vector` extension is enabled
// on the Neon database.

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
    mediaUrl: text("media_url"),
    durationSec: doublePrecision("duration_sec"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    meetingKind: varchar("meeting_kind", { length: 32 }),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    transcriptIdx: index("segments_transcript_idx").on(t.transcriptId),
    transcriptOrderIdx: uniqueIndex("segments_transcript_order_idx").on(
      t.transcriptId,
      t.orderIndex,
    ),
  }),
);

export const moments = pgTable(
  "moments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 64 }).notNull(),
    title: varchar("title", { length: 512 }),
    summary: text("summary"),
    startSec: doublePrecision("start_sec").notNull(),
    endSec: doublePrecision("end_sec").notNull(),
    score: doublePrecision("score"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recordingIdx: index("moments_recording_idx").on(t.recordingId),
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
  clips: many(clips),
  shares: many(shares),
}));

export const peopleRelations = relations(people, ({ one, many }) => ({
  account: one(accounts, {
    fields: [people.accountId],
    references: [accounts.id],
  }),
  attendees: many(attendees),
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
