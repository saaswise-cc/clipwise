# Clipwise

**AI-native meeting intelligence — self-hosted, open source, surfaced through Claude.**

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
│  • Electron shell          │  HTTPS  │  • Recording + transcript    │
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

1. **Mac desktop recorder** — Electron app using Core Audio Taps (macOS 14.2+) to capture both system audio and mic natively. No Recall.ai, no meeting-bot SDK, no third-party dependency in the capture path. Local Whisper handles transcription on-device.
2. **Self-hosted server** — Stores raw recordings, transcripts, extracted clips, and the moments database, and exposes an MCP interface for AI clients. Currently runs on Vercel + Neon Postgres; a Docker Compose packaging for fully local self-hosting is coming later.
3. **Clipwise MCP** — The bridge that lets Claude query your meeting history: search transcripts, pull clips, ask questions across the full corpus.

Primary recording target is **Google Meet**. Other platforms will follow.

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

If you're a solo operator, small team, or security-conscious org that doesn't want your meeting audio sitting on someone else's servers — Clipwise is built for you.

## Status

- ✅ Landing page live at [clipwiseapp.com](https://clipwiseapp.com)
- ✅ Waitlist open
- 🚧 Mac recorder (Electron + Core Audio Taps + local Whisper)
- ✅ Self-hosted server + moments database (Neon, live)
- 🚧 Clipwise MCP for Claude

## License

[Apache License 2.0](./LICENSE)
