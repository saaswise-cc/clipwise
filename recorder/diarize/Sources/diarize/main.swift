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

struct VoiceOut: Codable {
    let voiceIndex: Int
    let sourceLabel: String  // FluidAudio's own "S1"/"S2"/... — kept for traceability only
    let totalSeconds: Double
    let embedding: [Float]
}

struct SegmentOut: Codable {
    let start: Double
    let end: Double
    let voiceIndex: Int
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

        // Host echo (SAA-194 §4): the mic track is the host talking alone —
        // diarize it too (cheap, same cost as the tap track) and take its
        // dominant voice's embedding, weighted by speaking time so a stray
        // VAD sliver can't outvote the host's own long segments.
        var hostEmbedding: [Float]? = nil
        if FileManager.default.fileExists(atPath: micPath) {
            let micResult = try await manager.process(URL(fileURLWithPath: micPath))
            let micVoices = meanEmbeddings(micResult.segments)
            FileHandle.standardError.write(
                "diarize: mic track diarized into \(micVoices.count) voice(s): "
                    .appending(micVoices.map { "\($0.key)=\(String(format: "%.1f", $0.value.totalSeconds))s" }.joined(separator: ", "))
                    .appending("\n")
                    .data(using: .utf8)!)
            hostEmbedding = micVoices.max(by: { $0.value.totalSeconds < $1.value.totalSeconds })?.value
                .embedding
        }

        var hostEchoSourceLabel: String? = nil
        var hostEchoSimilarity: Float? = nil
        if let hostEmbedding {
            for (label, voice) in tapVoices {
                let similarity = cosineSimilarity(hostEmbedding, voice.embedding)
                FileHandle.standardError.write(
                    "diarize: host-echo check — tap voice \(label) vs host mic embedding: similarity=\(String(format: "%.3f", similarity))\n"
                        .data(using: .utf8)!)
                if similarity >= hostEchoCosineThreshold
                    && (hostEchoSimilarity == nil || similarity > hostEchoSimilarity!)
                {
                    hostEchoSourceLabel = label
                    hostEchoSimilarity = similarity
                }
            }
        }

        // Stable, deterministic voiceIndex assignment (sorted by FluidAudio's
        // own label) for every voice except the one dropped as host echo.
        let survivingLabels = tapVoices.keys.filter { $0 != hostEchoSourceLabel }.sorted()
        var indexByLabel: [String: Int] = [:]
        for (i, label) in survivingLabels.enumerated() { indexByLabel[label] = i + 1 }

        let voicesOut: [VoiceOut] = survivingLabels.map { label in
            let voice = tapVoices[label]!
            return VoiceOut(
                voiceIndex: indexByLabel[label]!, sourceLabel: label,
                totalSeconds: voice.totalSeconds, embedding: voice.embedding)
        }
        let segmentsOut: [SegmentOut] = tapResult.segments.compactMap { seg in
            guard let index = indexByLabel[seg.speakerId] else { return nil }  // the dropped host-echo voice
            return SegmentOut(
                start: Double(seg.startTimeSeconds), end: Double(seg.endTimeSeconds), voiceIndex: index)
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
