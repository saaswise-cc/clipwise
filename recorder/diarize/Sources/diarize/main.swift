// Splits the call-audio (tap) track into per-voice labels after a capture
// (SAA-194). Spawned by server/src/pipeline/diarize.ts as its own pipeline
// step, after ingest and before extract — never by main.js, and never
// blocking or failing a capture: any error here is written to the sidecar's
// `error` field and the caller treats that as "nothing to apply", not as a
// pipeline failure.
//
// Usage: diarize <tap-16k.wav> <mic-16k.wav> <models-dir> <output.json>
//
// The mic file is used only for the host-echo check (SAA-194 §4): a short
// clip of the host talking alone, diarized the same way, to find the
// dropped voice on the tap track that's really the host's own leakage.
//
// No network, ever. `ModelHub.offlineMode = true` is set before the models
// are loaded — with it on, a missing or revision-mismatched cache throws a
// typed error instead of FluidAudio silently reaching HuggingFace (or, worse,
// deleting files at `models-dir` to make room for a redownload). The models
// directory itself is populated ahead of time by fetch-models.sh, never by
// this tool.

import AVFoundation
import FluidAudio
import Foundation

let arguments = CommandLine.arguments

// Maintenance-only path, used by fetch-models.sh, never by the pipeline: the
// one place in this whole tool where a network fetch is allowed.
// `OfflineDiarizerModels.load(from:)` downloads-if-missing/mismatched when
// `ModelHub.offlineMode` is left at its default (false) — this just calls it
// against a real HuggingFace connection and lets that happen, populating
// `<dir>` with the 7 model files, config.json, provenance.json and the
// `.fluidaudio-revision` marker the runtime path below requires.
if arguments.count == 3, arguments[1] == "--fetch-models" {
    // Same parent-directory convention as the runtime path above: the files
    // land at <targetParentDir>/speaker-diarization/, not directly in it.
    let targetParentDir = URL(fileURLWithPath: arguments[2])
    do {
        _ = try await OfflineDiarizerModels.load(from: targetParentDir)
        print("diarize: fetched models into \(targetParentDir.path)/speaker-diarization")
    } catch {
        FileHandle.standardError.write("diarize: fetch failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    exit(0)
}

#if arch(arm64)
#else
FileHandle.standardError.write(
    "diarize: skipped — Apple Silicon only, this Mac's arch is not arm64\n".data(using: .utf8)!)
exit(3)
#endif

guard arguments.count == 5 else {
    FileHandle.standardError.write(
        "usage: diarize <tap-16k.wav> <mic-16k.wav> <models-dir> <output.json>\n".data(
            using: .utf8)!)
    exit(2)
}
let tapPath = arguments[1]
let micPath = arguments[2]
// The PARENT of where the models actually live. FluidAudio's ModelHub joins
// `repo.folderName` ("speaker-diarization" for the diarizer repo — confirmed
// against Sources/FluidAudio/ModelNames.swift) onto whatever directory is
// passed to `OfflineDiarizerModels.load(from:)`, so the 7 model files and
// the `.fluidaudio-revision` marker sit at `<modelsParentDir>/speaker-
// diarization/`, one level below this argument — not directly inside it.
let modelsParentDir = URL(fileURLWithPath: arguments[3])
let outputPath = arguments[4]

// Cosine-similarity cut-off for the host-echo check (SAA-194 §4) — a
// completely different quantity from the diarizer's own clustering
// threshold below, and never derived from it. From SAA-94 experiment C's
// cross-call similarity matrix: true (same-person) matches scored
// 0.83-0.96, wrong pairs at most 0.305. A host echo is the same voice
// recorded twice, so it should score in the true-match range — this sits
// with margin on both sides of that gap.
let hostEchoCosineThreshold: Float = 0.55

// The diarizer's own clustering threshold — one of many OfflineDiarizerConfig
// parameters below, all set to fluidaudiocli's offline-mode defaults
// (ProcessCommand.swift's ParsedArgs), because this is the exact
// configuration SAA-94 experiment C validated against the Fathom answer
// keys. Coincidentally also 0.6, fluidaudiocli's own default — not derived
// from hostEchoCosineThreshold above, which measures something else
// entirely (voice-to-voice similarity, not segmentation/clustering).
let diarizationClusteringThreshold: Double = 0.6

// A diarized voice with less total speech than this is folded back onto
// `them` rather than becoming its own Voice N (SAA-194, addition/fix
// 2026-09-24 #2). Found empirically: the first 09-08 "4th voice" (7.3s)
// looked like host echo only because Fathom's start-only timestamps
// overlap whoever spoke during the host's own turns — a handful of short
// interjections from someone else, misread as "100% Jon." 15s is well
// above that scale (five ~1.5s interjections) while still comfortably
// below any real participant's contribution to a multi-minute call.
let minimumVoiceSeconds: Double = 15.0

// Clip selection for naming (SAA-195): up to this many clips per voice, each
// within this length range, single-voice only — no overlap with another
// surviving voice's speech, and no overlap with any mic-track speech at all
// (so the clip is never colored by the host also talking underneath it).
let maxClipsPerVoice = 3
let minClipSeconds: Double = 4.0
let maxClipSeconds: Double = 6.0

struct ClipRange: Codable {
    let start: Double
    let end: Double
}

struct VoiceOut: Codable {
    let voiceIndex: Int
    let sourceLabel: String  // FluidAudio's own "S1"/"S2"/... — kept for traceability only
    let totalSeconds: Double
    let embedding: [Float]
    let clipRanges: [ClipRange]
}

// voiceIndex is nil for a diarized segment that exists (FluidAudio found
// speech there) but was excluded from `voices` — either dropped as host
// echo or folded back for being under minimumVoiceSeconds. That's a
// different fact from "no diarized coverage here at all" (a true gap under
// a whisper segment), and the caller (pipeline/diarize.ts) needs to tell
// them apart: an excluded segment's time range must stay on `them`, not
// get swept into the nearest surviving voice by its gap-filling fallback.
struct SegmentOut: Codable {
    let start: Double
    let end: Double
    let voiceIndex: Int?
}

struct DiarizeSidecar: Codable {
    let model: String
    let modelRevision: String
    let clusteringThreshold: Double
    let hostEchoThreshold: Float
    let processingTimeSeconds: Double
    let voices: [VoiceOut]
    let segments: [SegmentOut]
    let hostEchoSourceLabel: String?
    let hostEchoSimilarity: Float?
    let error: String?
}

func writeSidecar(_ sidecar: DiarizeSidecar) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(sidecar) else {
        FileHandle.standardError.write("diarize: failed to encode sidecar\n".data(using: .utf8)!)
        return
    }
    try? data.write(to: URL(fileURLWithPath: outputPath))
}

func fail(_ message: String) -> Never {
    writeSidecar(
        DiarizeSidecar(
            model: "fluidaudio-community-1", modelRevision: "",
            clusteringThreshold: diarizationClusteringThreshold,
            hostEchoThreshold: hostEchoCosineThreshold, processingTimeSeconds: 0, voices: [], segments: [],
            hostEchoSourceLabel: nil, hostEchoSimilarity: nil, error: message))
    FileHandle.standardError.write("diarize: \(message)\n".data(using: .utf8)!)
    exit(1)
}

// Duration-weighted mean embedding per FluidAudio speaker label — the same
// rule SAA-94's scratch scoring (embed_compare.py) used for the titanet and
// FluidAudio comparisons.
func meanEmbeddings(_ segments: [TimedSpeakerSegment]) -> [String: (embedding: [Float], totalSeconds: Double)]
{
    var sums: [String: [Float]] = [:]
    var weights: [String: Double] = [:]
    for seg in segments {
        let duration = Double(seg.durationSeconds)
        var sum = sums[seg.speakerId] ?? [Float](repeating: 0, count: seg.embedding.count)
        for i in 0..<min(sum.count, seg.embedding.count) {
            sum[i] += seg.embedding[i] * Float(duration)
        }
        sums[seg.speakerId] = sum
        weights[seg.speakerId, default: 0] += duration
    }
    var out: [String: (embedding: [Float], totalSeconds: Double)] = [:]
    for (label, sum) in sums {
        let weight = weights[label] ?? 1
        out[label] = (sum.map { $0 / Float(weight) }, weight)
    }
    return out
}

// Mono Float32 samples straight off disk, at the file's own sample rate —
// both tap and mic 16k wavs are already 16kHz mono by construction
// (transcribe.py's ffmpeg downsample), matching what the offline pipeline
// expects, so no resampling happens here.
func readMonoFloatSamples(_ url: URL) throws -> (samples: [Float], sampleRate: Double) {
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
        throw NSError(
            domain: "diarize", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "could not allocate a read buffer for \(url.path)"])
    }
    try file.read(into: buffer)
    guard let channelData = buffer.floatChannelData?[0] else {
        throw NSError(
            domain: "diarize", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "no float channel data after reading \(url.path)"])
    }
    return (Array(UnsafeBufferPointer(start: channelData, count: Int(buffer.frameLength))), format.sampleRate)
}

// Sorted, overlap-merged [start, end) intervals.
func mergeIntervals(_ intervals: [(Double, Double)]) -> [(Double, Double)] {
    guard !intervals.isEmpty else { return [] }
    let sorted = intervals.sorted { $0.0 < $1.0 }
    var merged = [sorted[0]]
    for (s, e) in sorted.dropFirst() {
        if s <= merged[merged.count - 1].1 {
            merged[merged.count - 1].1 = max(merged[merged.count - 1].1, e)
        } else {
            merged.append((s, e))
        }
    }
    return merged
}

// The complement of `intervals` within [0, duration) — the windows where
// none of `intervals` covers.
func complement(of intervals: [(Double, Double)], duration: Double) -> [(Double, Double)] {
    var gaps: [(Double, Double)] = []
    var cursor = 0.0
    for (s, e) in mergeIntervals(intervals) {
        if s > cursor { gaps.append((cursor, s)) }
        cursor = max(cursor, e)
    }
    if cursor < duration { gaps.append((cursor, duration)) }
    return gaps
}

func extractSamples(_ samples: [Float], sampleRate: Double, windows: [(Double, Double)]) -> [Float] {
    var out: [Float] = []
    for (s, e) in windows {
        let startIndex = max(0, Int(s * sampleRate))
        let endIndex = min(samples.count, Int(e * sampleRate))
        guard endIndex > startIndex else { continue }
        out.append(contentsOf: samples[startIndex..<endIndex])
    }
    return out
}

// A single embedding representing every voice found, combined rather than
// picking one (SAA-194, addition/fix 2026-09-24 #3): on audio that should
// be one speaker, any residual clustering fragmentation is blended back
// together by weighting each fragment's contribution by how much of the
// audio it actually covers, instead of gambling that the single largest
// fragment is the clean one — which is exactly what picked a wrong 715s
// mic-track cluster on 09-08 under the old "take the longest cluster" rule.
func combinedEmbedding(_ voices: [String: (embedding: [Float], totalSeconds: Double)]) -> [Float]? {
    guard let dim = voices.values.first?.embedding.count else { return nil }
    var sum = [Float](repeating: 0, count: dim)
    var weight = 0.0
    for (_, voice) in voices {
        for i in 0..<min(dim, voice.embedding.count) { sum[i] += voice.embedding[i] * Float(voice.totalSeconds) }
        weight += voice.totalSeconds
    }
    guard weight > 0 else { return nil }
    return sum.map { $0 / Float(weight) }
}

func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
    var dot: Float = 0
    var normA: Float = 0
    var normB: Float = 0
    for i in 0..<min(a.count, b.count) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }
    let denom = normA.squareRoot() * normB.squareRoot()
    return denom > 0 ? dot / denom : 0
}

// Subtract `others` (already sorted or not — doesn't matter) from a single
// [start, end) window, returning the pieces of it that survive.
func subtractIntervals(_ window: (Double, Double), _ others: [(Double, Double)]) -> [(Double, Double)] {
    var pieces = [window]
    for other in others {
        var next: [(Double, Double)] = []
        for (s, e) in pieces {
            let os = max(s, other.0)
            let oe = min(e, other.1)
            guard os < oe else {
                next.append((s, e))  // no overlap with this one
                continue
            }
            if s < os { next.append((s, os)) }
            if oe < e { next.append((oe, e)) }
        }
        pieces = next
    }
    return pieces
}

// Up to `maxClipsPerVoice` clean windows of `minClipSeconds`...`maxClipSeconds`
// for one voice: single-voice only (no overlap with any other surviving
// voice's segments) and no overlap with any mic-track speech at all
// (micSpeechRanges), longest clean stretch first (SAA-195).
//
// Consecutive segments of the SAME voice separated by a short gap are
// merged into one "run" first — otherwise a 2s segment right next to
// another 2.5s segment of the same voice, obviously one continuous turn,
// would each be too short to qualify alone.
func selectClips(
    ownSegments: [(Double, Double)],
    otherVoiceSegments: [(Double, Double)],
    micSpeechRanges: [(Double, Double)]
) -> [ClipRange] {
    let mergeGapSeconds = 0.5
    let sorted = ownSegments.sorted { $0.0 < $1.0 }
    var runs: [(Double, Double)] = []
    for (s, e) in sorted {
        if let last = runs.last, s - last.1 <= mergeGapSeconds {
            runs[runs.count - 1].1 = max(last.1, e)
        } else {
            runs.append((s, e))
        }
    }

    var candidates: [(clip: (Double, Double), cleanLength: Double)] = []
    for run in runs {
        for clean in subtractIntervals(run, otherVoiceSegments + micSpeechRanges) {
            let cleanLength = clean.1 - clean.0
            guard cleanLength >= minClipSeconds else { continue }
            let clipEnd = cleanLength > maxClipSeconds ? clean.0 + maxClipSeconds : clean.1
            candidates.append((clip: (clean.0, clipEnd), cleanLength: cleanLength))
        }
    }
    // Longest clean stretch first — ranked by the ORIGINAL clean length, not
    // the (possibly trimmed) clip length, so a 20s clean run outranks a
    // barely-4s one even though both get trimmed to at most 6s.
    candidates.sort { $0.cleanLength > $1.cleanLength }
    return candidates.prefix(maxClipsPerVoice).map { ClipRange(start: $0.clip.0, end: $0.clip.1) }
}

// No Task{}/DispatchSemaphore wrapper here — this file is literally
// main.swift, which Swift treats as an implicit async context at the top
// level (SE-0343), so `try await` works directly. An earlier version of
// this file used Task{} + semaphore.wait() to bridge into async from a
// synchronous top level; that's the wrong tool for a main.swift file
// specifically, and it deadlocked for real: semaphore.wait() blocks the
// only thread the cooperative thread pool has available, so the Task
// wrapping the actual work never got to run. Caught during SAA-194's own
// verification (fetch-models.sh hung indefinitely — near-zero CPU, no
// progress — rather than erroring or completing).
do {
    ModelHub.offlineMode = true

        let revisionMarker = modelsParentDir
            .appendingPathComponent("speaker-diarization")
            .appendingPathComponent(".fluidaudio-revision")
        let modelRevision =
            (try? String(contentsOf: revisionMarker, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"

        let configuration = MLModelConfigurationUtils.defaultConfiguration(computeUnits: .all)
        let models = try await OfflineDiarizerModels.load(
            from: modelsParentDir, configuration: configuration)

        // Every parameter here is fluidaudiocli's offline-mode default
        // (ProcessCommand.swift's ParsedArgs, offline section) — this is
        // deliberately the exact configuration SAA-94 experiment C ran and
        // validated against the Fathom answer keys, not a configuration we
        // chose. No `.withSpeakers(...)` call either: no speaker-count hint,
        // same as experiment C.
        let offlineConfig = OfflineDiarizerConfig(
            clusteringThreshold: diarizationClusteringThreshold,
            Fa: 0.07,
            Fb: 0.8,
            windowDuration: 10.0,
            sampleRate: 16_000,
            segmentationStepRatio: 0.2,
            embeddingBatchSize: 32,
            embeddingExcludeOverlap: true,
            embeddingSkipStrategy: .none,
            minSegmentDuration: 1.0,
            minGapDuration: 0.1,
            exclusiveSegments: true,
            speechOnsetThreshold: 0.5,
            speechOffsetThreshold: 0.5,
            segmentationMinDurationOn: 0.0,
            segmentationMinDurationOff: 0.0,
            maxVBxIterations: 20,
            convergenceTolerance: 1e-4,
            embeddingExportPath: nil
        )
        let manager = OfflineDiarizerManager(config: offlineConfig)
        manager.initialize(models: models)

        let start = Date()
        // No speaker-count hint on the tap track — SAA-194's whole point is
        // that it counts correctly unassisted (confirmed in experiment C).
        let tapResult = try await manager.process(URL(fileURLWithPath: tapPath))
        let processingTime = Date().timeIntervalSince(start)

        let tapVoices = meanEmbeddings(tapResult.segments)

        // Host reference embedding (SAA-194 §4, fixed 2026-09-24): built
        // ONLY from mic audio where the tap track has no diarized speech at
        // all — nobody on the call is talking, so anything on the mic there
        // is the host and only the host. This replaced diarizing the whole
        // mic track and taking its longest cluster, which on 09-08 picked a
        // 715s cluster out of 5 the mic track fragmented into — the mic
        // track is not reliably one clean cluster over a long call, so nor
        // was "the longest one" reliably the host.
        var hostEmbedding: [Float]? = nil
        if FileManager.default.fileExists(atPath: micPath) {
            let tapSpeechIntervals = tapResult.segments.map {
                (Double($0.startTimeSeconds), Double($0.endTimeSeconds))
            }
            let (micSamples, micSampleRate) = try readMonoFloatSamples(URL(fileURLWithPath: micPath))
            let micDuration = Double(micSamples.count) / micSampleRate
            let tapSilentWindows = complement(of: tapSpeechIntervals, duration: micDuration)
            let restrictedSamples = extractSamples(micSamples, sampleRate: micSampleRate, windows: tapSilentWindows)
            let restrictedSeconds = Double(restrictedSamples.count) / micSampleRate
            FileHandle.standardError.write(
                "diarize: host reference — \(tapSilentWindows.count) tap-silent window(s), \(String(format: "%.1f", restrictedSeconds))s of mic audio\n"
                    .data(using: .utf8)!)
            // Below this, whatever diarization says about it is noise, not a
            // usable host embedding — skip rather than guess.
            if restrictedSeconds >= 3.0 {
                let restrictedResult = try await manager.process(audio: restrictedSamples)
                let restrictedVoices = meanEmbeddings(restrictedResult.segments)
                FileHandle.standardError.write(
                    "diarize: host reference audio diarized into \(restrictedVoices.count) voice(s): "
                        .appending(restrictedVoices.map { "\($0.key)=\(String(format: "%.1f", $0.value.totalSeconds))s" }.joined(separator: ", "))
                        .appending("\n")
                        .data(using: .utf8)!)
                // Combined, not "take the longest" (see combinedEmbedding's
                // own comment) — the fix this whole block exists for.
                hostEmbedding = combinedEmbedding(restrictedVoices)
            } else {
                FileHandle.standardError.write(
                    "diarize: host reference — too little tap-silent mic audio, skipping host-echo check\n"
                        .data(using: .utf8)!)
            }
        }

        var hostEchoSourceLabel: String? = nil
        var hostEchoSimilarity: Float? = nil
        if let hostEmbedding {
            for (label, voice) in tapVoices {
                let similarity = cosineSimilarity(hostEmbedding, voice.embedding)
                FileHandle.standardError.write(
                    "diarize: host-echo check — tap voice \(label) vs host reference embedding: similarity=\(String(format: "%.3f", similarity))\n"
                        .data(using: .utf8)!)
                if similarity >= hostEchoCosineThreshold
                    && (hostEchoSimilarity == nil || similarity > hostEchoSimilarity!)
                {
                    hostEchoSourceLabel = label
                    hostEchoSimilarity = similarity
                }
            }
        }

        // Mic speech ranges for clip selection (SAA-195), independent of and
        // separate from the host-reference computation above: a full,
        // ordinary diarization of the whole mic track. Its cluster identity
        // doesn't matter here — this is deliberately not repeating the
        // "pick the right cluster" problem the host reference had, since all
        // that's needed is "was anyone speaking on mic at all during this
        // window," for which every segment counts regardless of speaker.
        var micSpeechRanges: [(Double, Double)] = []
        if FileManager.default.fileExists(atPath: micPath) {
            let micResult = try await manager.process(URL(fileURLWithPath: micPath))
            micSpeechRanges = micResult.segments.map { (Double($0.startTimeSeconds), Double($0.endTimeSeconds)) }
            FileHandle.standardError.write(
                "diarize: mic speech ranges for clip selection — \(micSpeechRanges.count) segment(s)\n"
                    .data(using: .utf8)!)
        }

        // A voice is excluded — folded back onto `them`, no Voice N of its
        // own — when it's the host echo, or when it falls under
        // minimumVoiceSeconds regardless of host-echo status. Both are
        // logged the same way: the distinction that matters downstream is
        // "real voice" vs "not," not which rule excluded it.
        var excludedReasons: [String: String] = [:]
        if let hostEchoSourceLabel {
            excludedReasons[hostEchoSourceLabel] = "host echo (similarity \(String(format: "%.3f", hostEchoSimilarity ?? 0)))"
        }
        for (label, voice) in tapVoices where voice.totalSeconds < minimumVoiceSeconds && excludedReasons[label] == nil {
            excludedReasons[label] = "under minimumVoiceSeconds (\(String(format: "%.1f", voice.totalSeconds))s < \(minimumVoiceSeconds)s)"
        }
        for (label, reason) in excludedReasons {
            FileHandle.standardError.write(
                "diarize: voice \(label) excluded — \(reason); its segments stay on `them`\n".data(using: .utf8)!)
        }

        // Stable, deterministic voiceIndex assignment (sorted by FluidAudio's
        // own label) for every surviving (non-excluded) voice.
        let survivingLabels = tapVoices.keys.filter { excludedReasons[$0] == nil }.sorted()
        var indexByLabel: [String: Int] = [:]
        for (i, label) in survivingLabels.enumerated() { indexByLabel[label] = i + 1 }

        var segmentsByLabel: [String: [(Double, Double)]] = [:]
        for seg in tapResult.segments {
            segmentsByLabel[seg.speakerId, default: []].append(
                (Double(seg.startTimeSeconds), Double(seg.endTimeSeconds)))
        }

        let voicesOut: [VoiceOut] = survivingLabels.map { label in
            let voice = tapVoices[label]!
            let ownSegments = segmentsByLabel[label] ?? []
            let otherSegments = survivingLabels
                .filter { $0 != label }
                .flatMap { segmentsByLabel[$0] ?? [] }
            let clipRanges = selectClips(
                ownSegments: ownSegments, otherVoiceSegments: otherSegments,
                micSpeechRanges: micSpeechRanges)
            FileHandle.standardError.write(
                "diarize: voice \(label) — \(clipRanges.count) clip(s) selected for naming\n".data(using: .utf8)!)
            return VoiceOut(
                voiceIndex: indexByLabel[label]!, sourceLabel: label,
                totalSeconds: voice.totalSeconds, embedding: voice.embedding, clipRanges: clipRanges)
        }
        // Every diarized segment is emitted, including excluded voices' —
        // with voiceIndex nil for those, so the caller can tell "diarized
        // but excluded, leave on them" apart from "no diarized coverage at
        // all here" (a true gap, eligible for its own nearest-voice
        // fallback). See SegmentOut's own comment.
        let segmentsOut: [SegmentOut] = tapResult.segments.map { seg in
            SegmentOut(
                start: Double(seg.startTimeSeconds), end: Double(seg.endTimeSeconds),
                voiceIndex: indexByLabel[seg.speakerId])
        }

        writeSidecar(
            DiarizeSidecar(
                model: "fluidaudio-community-1",
                modelRevision: modelRevision,
                clusteringThreshold: diarizationClusteringThreshold,
                hostEchoThreshold: hostEchoCosineThreshold,
                processingTimeSeconds: processingTime,
                voices: voicesOut,
                segments: segmentsOut,
                hostEchoSourceLabel: hostEchoSourceLabel,
                hostEchoSimilarity: hostEchoSimilarity,
                error: nil
            ))
} catch {
    fail("\(error)")
}
