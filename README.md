# Clipwise

**Team-owned, self-hosted meeting intelligence. Captured locally, surfaced through Claude.**

Clipwise records your meetings, transcribes them locally, and builds a persistent database of the moments that matter — decisions, commitments, objections, insights — that you can query across every meeting you've ever had. It's designed to live inside Claude via MCP, not to be another destination platform you have to log into.

Website: [clipwiseapp.com](https://clipwiseapp.com) · [Join the waitlist](https://clipwiseapp.com/#waitlist)

> ⚠️ **Early development.** The landing page is live; the recorder, server, and MCP are actively being built. Star the repo or join the waitlist to hear when the first release ships.

---

## The thesis

Meeting recorders today (Fathom, Gong, Grain, Otter) are destination platforms. You record → they store your data on their servers → you log into their UI to review summaries. The recording is a means to an end, and that end is *their product*.

Clipwise inverts that:

- **Your recordings and transcripts never leave your infrastructure.** No third-party capture SDK, no vendor cloud, no "AI notetaker" bot joining your calls.
- **The interface is Claude, not a web app.** Ask questions in natural language across every meeting you've ever had. "What did the ACME team commit to in Q2?" "Show me every objection we've heard about pricing." "Pull the clip where Sarah described the new architecture."
- **A persistent extracted-moments database grows over time.** Individual meeting summaries are commodity; the compounding value is a searchable, structured memory of every important thing anyone has said, across months and years.

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Mac Desktop Recorder      │         │  Self-Hosted Server          │
│  ────────────────────────  │         │  ──────────────────────────  │
│  • Shell: Electron         │ spawns  │  • Recording + transcript    │
│  • Core Audio Taps         │────────▶│    storage                   │
│    (native macOS capture)  │         │  • Moment extraction         │
│  • Local Whisper           │         │  • Moment DB (Postgres +     │
│    transcription           │         │    vector index)             │
│                            │         │  • MCP server interface      │
└────────────────────────────┘         └──────────────┬───────────────┘
                                                      │ MCP
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │  Claude (Desktop / Code /    │
                                       │  API) via Clipwise MCP       │
                                       │  ──────────────────────────  │
                                       │  Query across every meeting  │
                                       │  in natural language         │
                                       └──────────────────────────────┘
```

### Components

1. **Mac desktop recorder** — an Electron menu bar app that spawns and manages the capture subprocesses. Capture is Clipwise's own Swift binaries using Core Audio Taps (macOS 14.2+) for system audio and Core Audio directly for the mic, recording both natively — no Recall.ai, no meeting-bot SDK, no third-party dependency in the capture path. Stopping a capture starts the rest on its own: the recorder spawns the capture→moments pipeline, which transcribes on-device through whisper.cpp, ingests, and extracts moments without anyone driving it.
2. **Self-hosted server** — A long-running Node/TypeScript container that stores raw recordings, transcripts, and the moments database, and exposes a REST API consumed by the MCP. It's a single Docker artifact from day one: the hosted deployment (Fly.io / Railway / Render) and any user-run self-hosted deployment run the same image. Persistence is standard Postgres (with `pgvector`); Neon is the currently-used managed provider, but the connection is plain `pg` so any Postgres works. The recorder does not go through the REST API: it spawns this server's pipeline against the checkout it was built from, and that writes to Postgres directly.
3. **Clipwise MCP** — The bridge that lets Claude query your meeting history. Two tools today: `search_moments`, which searches the extracted-moments database by text, by meaning, by moment kind, by recording, or by who was on the call; and `get_transcript`, which returns one recording's transcript with per-segment timestamps and speaker labels.

## What makes it different

|                            | Clipwise                        | Fathom / Gong / Grain          |
| -------------------------- | ------------------------------- | ------------------------------ |
| **Where data lives**       | Your infrastructure             | Vendor cloud                   |
| **Capture path**           | Native Core Audio Taps          | Bot joins the call, or SDK     |
| **Transcription**          | Local Whisper, on-device        | Vendor cloud                   |
| **Interface**              | Claude via MCP                  | Vendor web UI                  |
| **Cross-meeting queries**  | Persistent moment DB, ask Claude| Per-meeting summaries          |
| **License**                | Apache 2.0, open source         | Proprietary, closed            |
| **Credentials / recordings** | Never leave your infra         | Uploaded to vendor             |

If you want your meeting intelligence to live on infrastructure you control rather than a vendor's cloud, Clipwise is built for you.

## Status

Tracked in Linear, not here. What is built, what is being built and why each
call was made lives on the issues; a list in this file is a second copy that
goes stale the moment the first one moves.

## Recorder setup

Covers the Mac recorder only; the server and MCP have their own setup.

**Prerequisites**

- macOS 14.2+ (Core Audio Taps floor)
- Swift and Node toolchains
- `ffmpeg` on `PATH` — `brew install ffmpeg`. Not optional, but not for capture: `transcribe.py` uses it
  to downsample both tracks to the 16 kHz whisper.cpp wants. The mic is captured by Clipwise's own
  `miccap` binary, which replaced the ffmpeg mic path.

**Build the Swift binaries.** All three are gitignored build outputs, so a fresh
clone has none of them.

```sh
(cd recorder && swiftc -O audiodevs.swift -o audiodevs)
(cd recorder/systemtap && swift build -c release)
(cd recorder/miccap && swift build -c release)
```

**Install the app shell.**

```sh
(cd recorder/app && npm install && npx install-electron)
```

`npx install-electron` is not optional. Electron 43's package manifest has no
`scripts` key at all, so nothing fetches the runtime binary during `npm install`
— the install exits clean and reports no vulnerabilities while leaving an app
that cannot launch. Verified from the installed package on disk 2026-08-09, with
`ignore-scripts` confirmed `false`.

**Package it as an app.** `recorder/app/build-app.sh` does everything above and
produces `recorder/app/dist/Clipwise.app` — a menu bar app you can double-click
and add to Login Items in System Settings. It signs with the Developer ID
identity; override with `CLIPWISE_SIGN_IDENTITY` if you have your own.

```sh
(cd recorder/app && ./build-app.sh)
```

It is not notarized and there is no DMG, so it is a build for the machine that
built it rather than something to hand to anyone. The app never registers
itself for launch at login — Login Items is a thing you add it to.

The bundle carries the three Swift binaries. It does not carry the server, so
`build-app.sh` stamps the path of this checkout into the bundle and the packaged
app runs the capture→moments pipeline out of it. Move the repo and rebuild.

A packaged run has no terminal to print to, so everything it would have written
to stderr goes to `~/Library/Application Support/clipwise/recorder.log`. That is
where notification delivery, child spawn failures and pipeline errors are.

**Capture output.** Each capture writes to
`~/Library/Application Support/clipwise/recordings/`, sharing one timestamp
stem: the two audio tracks, a log per child, and `manifest-<stem>.json`.

The manifest is written at capture start, before any child spawns, and is what
identifies a recording. Its `recording_id` is a generated UUID — the stem stays
the human-readable handle, but it is not an identifier: timestamps collide and
depend on a correct clock. Consumers key on `recording_id` (it is what the
normalized transcript contract carries as `source_recording_id`).

It also records the device and sample rate per track, which nothing else
preserves — a headset can put the mic at 24 kHz against a 48 kHz tap, and the
children only mention their rates in stderr logs. Both rates come from one
CoreAudio query at start rather than from the children, which report their
formats milliseconds later; `sample_rate_source` on each track names that
provenance, so a manifest recovered from a capture's own artifacts is
distinguishable from one written live.

**Transcription** — needed by anyone who records, not only by anyone calling
`transcribe.py` by hand: stopping a capture spawns the pipeline, and its first
step is transcription.

- `brew install whisper-cpp` for the `whisper-cli` binary
- The GGML model — `transcribe.py` prints the download command in its error message.

## License

[Apache License 2.0](./LICENSE)
