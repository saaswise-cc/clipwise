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
│  • Shell: Electron         │  HTTPS  │  • Recording + transcript    │
│  • Core Audio Taps         │────────▶│    storage                   │
│    (native macOS capture)  │         │  • Clip extraction           │
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

1. **Mac desktop recorder** — an Electron menu bar app that spawns and manages the capture subprocesses. Capture is Clipwise's own Swift binary using Core Audio Taps (macOS 14.2+) to record system audio and mic natively — no Recall.ai, no meeting-bot SDK, no third-party dependency in the capture path. Transcription is a separate on-device step, run via whisper.cpp as a CLI — not invoked by the recorder.
2. **Self-hosted server** — A long-running Node/TypeScript container that stores raw recordings, transcripts, extracted clips, and the moments database, and exposes a REST API consumed by the recorder and the MCP. It's a single Docker artifact from day one: the hosted deployment (Fly.io / Railway / Render) and any user-run self-hosted deployment run the same image. Persistence is standard Postgres (with `pgvector`); Neon is the currently-used managed provider, but the connection is plain `pg` so any Postgres works.
3. **Clipwise MCP** — The bridge that lets Claude query your meeting history: search transcripts, pull clips, ask questions across every meeting.

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

- ✅ Landing page live at [clipwiseapp.com](https://clipwiseapp.com)
- ✅ Waitlist open
- 🚧 Mac recorder (Electron shell around Swift Core Audio Taps capture + local whisper.cpp CLI)
- ✅ Self-hosted server + moments database (Neon, live)
- 🚧 Clipwise MCP for Claude

## Recorder setup

Covers the Mac recorder only; the server and MCP have their own setup.

**Prerequisites**

- macOS 14.2+ (Core Audio Taps floor)
- Swift and Node toolchains
- `ffmpeg` on `PATH` — `brew install ffmpeg`. Required for mic capture, not optional.

**Build the Swift binaries.** Both are gitignored build outputs, so a fresh clone has neither.

```sh
(cd recorder && swiftc -O audiodevs.swift -o audiodevs)
(cd recorder/systemtap && swift build -c release)
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

**Transcription** — only needed for `transcribe.py`, not for recording.

- `brew install whisper-cpp` for the `whisper-cli` binary
- The GGML model — `transcribe.py` prints the download command in its error message.

## License

[Apache License 2.0](./LICENSE)
