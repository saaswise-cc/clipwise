// Regression check for matchEvent() (SAA-115) against the real numbers
// measured in the 2026-09-17 dry run — five matches and two named
// non-matches, from 22 real captures. Validates the matching rule without
// needing live Google access.
//
// Usage:
//   tsx src/pipeline/check-match-calendar.ts
//
// Exit code 0: every case reproduces the recorded partition. Nonzero: it
// doesn't, and the mismatching case is printed.

import { matchEvent } from "./match-calendar.js";
import type { CalendarEvent } from "../lib/google-calendar.js";

function event(id: string, startIso: string, recurringEventId?: string): CalendarEvent {
  return { id, start: { dateTime: startIso }, recurringEventId };
}

type Case = {
  name: string;
  eventStartIso: string;
  offsetMs: number; // capture.startedAt - event.start, matches the Linear comment's sign
  expectMatch: boolean;
};

// Five real matches, offsets exactly as recorded 2026-09-17.
const CASES: Case[] = [
  { name: "09-08 Weekly Initiative Sync", eventStartIso: "2026-09-08T17:30:00Z", offsetMs: 2000, expectMatch: true },
  { name: "09-10 Jon / Tyler", eventStartIso: "2026-09-10T18:00:00Z", offsetMs: 79000, expectMatch: true },
  { name: "09-10 Mike / Jon", eventStartIso: "2026-09-10T19:00:00Z", offsetMs: 496000, expectMatch: true },
  { name: "09-14 Weekly Initiative Sync", eventStartIso: "2026-09-14T17:00:00Z", offsetMs: 41000, expectMatch: true },
  { name: "09-15 Mike / Jon", eventStartIso: "2026-09-15T19:00:00Z", offsetMs: -9000, expectMatch: true },
  // Smallest non-match: a personal call against a declined event, 17m02s away.
  { name: "smallest non-match (17m02s)", eventStartIso: "2026-09-16T12:00:00Z", offsetMs: 1022000, expectMatch: false },
  // The Slack call: same application, same session as a real match, but
  // 20m02s after the SAME event's start — must not match despite proximity.
  { name: "Slack call, must not match (20m02s)", eventStartIso: "2026-09-14T17:00:00Z", offsetMs: 1202000, expectMatch: false },
];

function main(): number {
  let failures = 0;
  for (const c of CASES) {
    const ev = event("evt-" + c.name, c.eventStartIso);
    const captureStartedAt = new Date(new Date(c.eventStartIso).getTime() + c.offsetMs);
    const result = matchEvent(captureStartedAt, [ev]);
    const matched = result !== null;
    const ok = matched === c.expectMatch && (!matched || result.offsetMs === c.offsetMs);
    process.stdout.write(
      `${ok ? "PASS" : "FAIL"} ${c.name}: expected match=${c.expectMatch}, ` +
        `got match=${matched}${matched ? ` offsetMs=${result!.offsetMs}` : ""}\n`,
    );
    if (!ok) failures += 1;
  }

  // originalStartTime must never be read. A moved instance whose
  // originalStartTime is far from the capture but whose real start is
  // close must still match on start.
  const movedInstance: CalendarEvent = {
    id: "evt-moved",
    start: { dateTime: "2026-09-08T13:30:00Z" },
    originalStartTime: { dateTime: "2026-09-08T13:00:00Z" },
  };
  const movedResult = matchEvent(new Date("2026-09-08T13:30:02Z"), [movedInstance]);
  const movedOk = movedResult !== null && movedResult.offsetMs === 2000;
  process.stdout.write(
    `${movedOk ? "PASS" : "FAIL"} moved instance matches on start, not originalStartTime\n`,
  );
  if (!movedOk) failures += 1;

  process.stdout.write(`\n${CASES.length + 1 - failures}/${CASES.length + 1} passed\n`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-match-calendar.ts")) {
  process.exit(main());
}
