// Connects a Google Calendar account (SAA-115 step 1). Mounted at `/` in
// index.ts, like transcriptRouter — its paths are fully qualified, not
// nested under /accounts/:accountId.

import { randomBytes } from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseQuery } from "../lib/http.js";
import { encrypt } from "../lib/crypto.js";
import { exchangeCode, listCalendars, selectSearchableCalendars } from "../lib/google-calendar.js";

export const oauthRouter = Router();

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

// state -> {accountId, expiresAt}. Generated and validated in this same
// process, deliberately not persisted (decision 1's ethos on the issue: no
// polling, no sync cursor, no jobs table — this is one flow, run once per
// calendar connection, by one local user). Single-use: deleted on lookup.
// Cost of the simpler choice: a connect attempt started right before a
// server restart has to be retried.
const pendingStates = new Map<string, { accountId: string; expiresAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

// A connect that's started and never completed (closed tab, denied
// consent) would otherwise sit in the map until restart — trivial for one
// user, unbounded in principle. Swept on every new entry rather than on a
// timer, so there's no extra scheduled thing running for a flow used this
// rarely.
function setState(state: string, accountId: string): void {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (value.expiresAt < now) pendingStates.delete(key);
  }
  pendingStates.set(state, { accountId, expiresAt: now + STATE_TTL_MS });
}

function oauthConfig(): { clientId: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new HttpError(500, "google_oauth_not_configured");
  }
  return { clientId, redirectUri };
}

const connectQuerySchema = z.object({ account_id: z.string().uuid() });

oauthRouter.get(
  "/oauth/google/connect",
  asyncHandler(async (req, res) => {
    const { account_id: accountId } = parseQuery(connectQuerySchema, req);
    const [account] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId));
    if (!account) throw new HttpError(404, "account_not_found");

    const { clientId, redirectUri } = oauthConfig();
    const state = randomBytes(16).toString("hex");
    setState(state, accountId);

    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", CALENDAR_READONLY_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  }),
);

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

oauthRouter.get(
  "/oauth/google/callback",
  asyncHandler(async (req, res) => {
    const { code, state } = parseQuery(callbackQuerySchema, req);

    const pending = pendingStates.get(state);
    pendingStates.delete(state); // single-use regardless of outcome
    if (!pending || pending.expiresAt < Date.now()) {
      throw new HttpError(400, "invalid_or_expired_state");
    }

    const { redirectUri } = oauthConfig();
    const tokens = await exchangeCode(code, redirectUri);
    if (!tokens.refreshToken) {
      // Only happens if Google re-consents without issuing a new refresh
      // token (e.g. prompt=consent was somehow bypassed) — access_type=
      // offline + prompt=consent above should always produce one.
      throw new HttpError(502, "google_did_not_return_a_refresh_token");
    }
    // calendarList, not the userinfo endpoint — see listCalendars' own
    // comment. Logged in full and not just the primary entry: this is
    // also the check for whether the LeadIQ share (jd@leadiq.com) is still
    // visible through Clipwise's own client, the premise the whole SAA-115
    // dry run rests on and which has so far only been confirmed through
    // the chat connector, never this one.
    const calendars = await listCalendars(tokens.accessToken);
    console.log(
      `oauth callback: calendarList for account=${pending.accountId} → ` +
        JSON.stringify(calendars, null, 2),
    );
    const primary = calendars.find((c) => c.primary);
    if (!primary) {
      throw new HttpError(502, "no_primary_calendar_in_calendarlist");
    }
    const calendarEmail = primary.id;

    // The list a match actually searches — computed once here, stored,
    // not recomputed per match. jd@leadiq.com (shared in, accessRole
    // reader) is included by this; Google's holiday/contacts calendars
    // and any freeBusyReader-only entry are not.
    const selection = selectSearchableCalendars(calendars);
    console.log(
      `oauth callback: searchable calendars for account=${pending.accountId} → ` +
        `included=${JSON.stringify(selection.included)}\n` +
        `  excluded: ${selection.excluded.map((e) => `${e.id} (${e.reason})`).join("; ") || "(none)"}`,
    );

    // UNIQUE(account_id, calendar_email) is exactly the conflict target
    // here — race-free in one statement, and consistent with how
    // applyCalendarMatch upserts invitees against its own unique index.
    const values = {
      accountId: pending.accountId,
      calendarEmail,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      searchedCalendarIds: selection.included,
    };
    await db
      .insert(schema.calendarConnections)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.calendarConnections.accountId, schema.calendarConnections.calendarEmail],
        set: values,
      });

    res
      .status(200)
      .type("text/plain")
      .send(`Connected ${calendarEmail}. You can close this tab.`);
  }),
);
