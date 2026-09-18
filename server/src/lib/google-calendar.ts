// Raw REST calls against Google's OAuth token endpoint and Calendar API.
// No googleapis/google-auth-library dependency — following lib/voyage.ts's
// existing precedent for an external API in this codebase: plain fetch, no
// retry wrapper, single attempt, throw on non-2xx.
//
// Every call carries an explicit timeout. voyage.ts's precedent has no
// story for a hang — a non-2xx throws, but Node's fetch has no default
// timeout, and this module's caller (match-calendar.ts) now runs FIRST in
// the pipeline, ahead of transcribe. A stalled request here doesn't fail a
// capture, it stalls it silently and indefinitely — indistinguishable from
// the walk-away stall SAA-183 exists to explain. A match that arrives late
// has no value (the whole point was availability before transcribe), so
// waiting longer is never the right call.

export const GOOGLE_API_TIMEOUT_MS = 5000;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// Carries the HTTP status so a caller can tell a share revocation (401/403,
// or 404 once the calendar is gone) apart from a generic failure — that
// distinction is the whole reason match-calendar.ts needs this rather than
// a plain Error.
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  }
  return { clientId, clientSecret };
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GoogleApiError(`google oauth token ${res.status}: ${text}`, res.status);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

export type TokenResult = {
  accessToken: string;
  refreshToken: string | null; // null on a refresh grant — Google doesn't reissue it
  expiresAt: Date;
  scope: string;
};

export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResult> {
  const { clientId, clientSecret } = credentials();
  const data = await postForm(TOKEN_ENDPOINT, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000),
    scope: String(data.scope ?? ""),
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const { clientId, clientSecret } = credentials();
  const data = await postForm(TOKEN_ENDPOINT, {
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  return {
    accessToken: String(data.access_token),
    refreshToken: null, // a refresh grant doesn't reissue the refresh token
    expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000),
    scope: String(data.scope ?? ""),
  };
}

export type CalendarListEntry = {
  id: string; // the calendar's own address — equals the account email on the primary entry
  summary?: string;
  primary?: boolean;
  accessRole?: string;
};

// Deliberately not the userinfo endpoint. That requires an identity scope
// (email/profile/openid) this app doesn't request — calendar.readonly is
// already a sensitive scope, and once this goes through Google's
// verification for External use, every additional scope is something to
// justify. calendarList is covered by calendar.readonly and returns the
// same value: the entry with primary=true has an id equal to the
// account's own email address.
export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
  const res = await fetch(`${CALENDAR_BASE}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GoogleApiError(`google calendarList ${res.status}: ${text}`, res.status);
  }
  const data = (await res.json()) as { items?: CalendarListEntry[] };
  return data.items ?? [];
}

// Meta-calendars Google adds to every calendarList automatically — holiday
// calendars, the contacts/birthdays calendar, and similarly-shaped group
// calendars — none of which represent a real meeting anyone could be on a
// call about. Matched by id shape rather than a fixed list, since Google
// adds new locale-specific holiday calendars over time.
const META_CALENDAR_PATTERN = /@group\.v\.calendar\.google\.com$/;

// freeBusyReader sees only busy/free blocks, never event details (title,
// attendees) — it could never produce a usable match, only ever a
// same-time false one with nothing to show for it.
const SEARCHABLE_ACCESS_ROLES = new Set(["owner", "writer", "reader"]);

export type CalendarSelection = {
  included: string[];
  excluded: Array<{ id: string; reason: string }>;
};

// Computed once at connect time (oauth.ts) and stored on the connection row
// as searched_calendar_ids — not recomputed on every match, which would be
// an extra Calendar API call per capture for a list that only changes when
// sharing changes.
export function selectSearchableCalendars(calendars: CalendarListEntry[]): CalendarSelection {
  const included: string[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  for (const cal of calendars) {
    if (META_CALENDAR_PATTERN.test(cal.id)) {
      excluded.push({ id: cal.id, reason: "google meta-calendar (holiday/contacts/etc.)" });
      continue;
    }
    if (!cal.accessRole || !SEARCHABLE_ACCESS_ROLES.has(cal.accessRole)) {
      excluded.push({
        id: cal.id,
        reason: `accessRole=${cal.accessRole ?? "(none)"} — no event detail visible`,
      });
      continue;
    }
    included.push(cal.id);
  }
  return { included, excluded };
}

export type CalendarEventAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
};

export type CalendarEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  // Only present when this instance was individually moved. Never used for
  // matching — SAA-115's dry run found a moved instance whose
  // originalStartTime would have missed the actual match by 30 minutes.
  originalStartTime?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  attendees?: CalendarEventAttendee[];
};

export async function listEvents(
  accessToken: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<CalendarEvent[]> {
  const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", timeMin.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  // singleEvents=true: each recurring instance comes back with its own
  // start/recurringEventId rather than the series master + RRULE — this is
  // what the settled matching rule (start alignment) and decision 4 (store
  // the id, not the rule) both need.
  url.searchParams.set("singleEvents", "true");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GoogleApiError(`google calendar events.list ${res.status}: ${text}`, res.status);
  }
  const data = (await res.json()) as { items?: CalendarEvent[] };
  return data.items ?? [];
}
