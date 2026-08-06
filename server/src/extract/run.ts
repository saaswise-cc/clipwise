// CLI: run extraction (and optionally verification) against a recording.
//
// Usage:
//   tsx src/extract/run.ts extract         <recording_id>
//   tsx src/extract/run.ts collapse        <recording_id> --run <uuid>
//   tsx src/extract/run.ts verify          <recording_id> --run <uuid> --fathom <path>
//   tsx src/extract/run.ts parse-fathom    <path>
//   tsx src/extract/run.ts embed-backfill

import { runCollapseOnly, runExtraction } from "./extract.js";
import { backfillMissingEmbeddings } from "./embeddings.js";
import { parseFathomLeaves } from "./fathom-leaves.js";
import { runCoverage } from "./harness.js";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "parse-fathom") {
    const fathomPath = rest[0];
    if (!fathomPath) {
      console.error("usage: run.ts parse-fathom <path>");
      process.exit(1);
    }
    const { leaves, excludedParents, ignoredSections } = parseFathomLeaves(fathomPath);
    console.log(`ignoredSections (${ignoredSections.length}): ${ignoredSections.join(", ")}`);
    console.log(`leaves: ${leaves.length}`);
    console.log(`excluded non-leaf parents: ${excludedParents.length}`);
    return;
  }
  if (cmd === "extract") {
    const recordingId = rest[0];
    if (!recordingId) {
      console.error("usage: run.ts extract <recording_id> [--no-collapse]");
      process.exit(1);
    }
    const applyCollapse = !rest.includes("--no-collapse");
    const result = await runExtraction(recordingId, { applyCollapse });
    console.log("");
    console.log("=== extraction summary ===");
    console.log(`run uuid:                        ${result.runUuid}`);
    console.log(`span count:                      ${result.spans.length}`);
    console.log(`tiling gaps:                     ${result.tilingGaps}`);
    console.log(`tiling overlaps:                 ${result.tilingOverlaps}`);
    console.log(`zero-yield spans:                ${result.spansYieldingZeroMoments.length}`);
    for (const s of result.spansYieldingZeroMoments) {
      console.log(`  - ${s.label}  (segments ${s.startSegmentIndex}..${s.endSegmentIndex})`);
    }
    console.log(`rows written to DB:              ${result.preCollapseMomentCount}`);
    console.log(`moments visible after collapse:  ${result.momentsVisibleAfterCollapse}`);
    console.log(`collapse groups:                 ${result.collapseGroupCount}`);
    console.log(`moments inside collapse groups:  ${result.momentsInCollapseGroups}`);
    console.log(`moments merged into reps:        ${result.collapseDroppedCount}`);
    const b = result.collapseBackstops;
    console.log(
      `collapse backstops (silent fixes): out-of-range=${b.outOfRangeDropped}  collisions=${b.collisionsDropped}  groups-discarded=${b.groupsDiscarded}  reps-replaced=${b.representativesReplaced}`,
    );
    console.log(
      `personnel-flagged (surviving reps + singletons): ${result.personnelAssessmentCount}   [NOT comparable to pre-collapse baseline: rep flag no longer OR'd, so flagged-only-losers hide behind unflagged reps]`,
    );
    console.log(`out-of-range (clamped):          ${result.outOfRangeCount}`);
    console.log(`elapsed:                         ${(result.elapsedMs / 1000).toFixed(1)}s`);
    return;
  }
  if (cmd === "collapse") {
    const recordingId = rest[0];
    const runIdx = rest.indexOf("--run");
    if (!recordingId || runIdx === -1) {
      console.error("usage: run.ts collapse <recording_id> --run <uuid>");
      process.exit(1);
    }
    const runUuid = rest[runIdx + 1];
    const plan = await runCollapseOnly(recordingId, runUuid);
    console.log("");
    console.log("=== collapse-only summary ===");
    console.log(`recording:                       ${recordingId}`);
    console.log(`run uuid:                        ${runUuid}`);
    console.log(`groups:                          ${plan.groups.length}`);
    console.log(`moments inside groups:           ${plan.groups.reduce((n, g) => n + g.indices.length, 0)}`);
    console.log(`moments marked collapsed_into:   ${plan.droppedCount}`);
    const b = plan.backstops;
    console.log(
      `collapse backstops (silent fixes): out-of-range=${b.outOfRangeDropped}  collisions=${b.collisionsDropped}  groups-discarded=${b.groupsDiscarded}  reps-replaced=${b.representativesReplaced}`,
    );
    return;
  }
  if (cmd === "verify") {
    const recordingId = rest[0];
    const runIdx = rest.indexOf("--run");
    const fathomIdx = rest.indexOf("--fathom");
    if (!recordingId || runIdx === -1 || fathomIdx === -1) {
      console.error("usage: run.ts verify <recording_id> --run <uuid> --fathom <path>");
      process.exit(1);
    }
    const runUuid = rest[runIdx + 1];
    const fathomPath = rest[fathomIdx + 1];
    const cov = await runCoverage(recordingId, runUuid, fathomPath);

    console.log("");
    console.log("=== coverage report ===");
    console.log(`recording:                ${recordingId}`);
    console.log(`run uuid:                 ${cov.runUuid}`);
    console.log(`fathom summary:           ${cov.fathomPath}`);
    console.log(`ignored sections:         ${cov.ignoredSections.join(", ")}`);
    console.log(`excluded non-leaf parents (${cov.excludedParents.length}):`);
    for (const p of cov.excludedParents) console.log(`  - [${p.section}] ${p.text}`);
    console.log(
      `filter regression:        bogus uuid ${cov.filterRegression.bogusUuid} returned ${cov.filterRegression.observedMoments} moments (${cov.filterRegressionPassed ? "OK" : "FAIL"})`,
    );
    console.log("");
    console.log(`duplicate density (before scoring):`);
    console.log(`  moments in run:         ${cov.momentCount}`);
    console.log(`  near-duplicate clusters: ${cov.duplicateClusters.length}`);
    console.log(`  moments inside clusters: ${cov.momentsInClusters}`);
    console.log(`  distinct after collapse: ${cov.distinctAfterCollapse} of ${cov.momentCount}`);
    for (const c of cov.duplicateClusters) {
      console.log(`    · [${c.indices.length}] ${c.representative}  (indices: ${c.indices.join(", ")})`);
    }
    for (const pass of [cov.full, cov.distinctOnly]) {
      console.log("");
      console.log(`=== ${pass.label} (pool ${pass.poolSize}) ===`);
      for (const r of pass.perLeaf) {
        const flag = r.passed ? "PASS" : "FAIL";
        const detail = r.momentIndex !== null ? `moment #${r.momentIndex} (${r.confidence})` : "no match";
        console.log(`  ${flag}  L${r.leaf.index}  [${r.leaf.section}]  ${r.leaf.text}`);
        console.log(`        → ${detail}`);
      }
      console.log(`covered ${pass.covered} of ${cov.total} leaves`);
    }
    console.log("");
    console.log("=== cluster representatives (dedup pass keeps the lowest index) ===");
    for (const c of cov.duplicateClusters) {
      const kept = Math.min(...c.indices);
      const dropped = c.indices.filter((i) => i !== kept);
      console.log(`  kept #${kept}, dropped #${dropped.join(", #")}  — ${c.representative}`);
    }
    console.log("");
    console.log("=== regression check: leaves that PASS on full but FAIL on distinct-only ===");
    const regressions: { leafIndex: number; fullMomentIndex: number | null }[] = [];
    for (let i = 0; i < cov.full.perLeaf.length; i++) {
      const fp = cov.full.perLeaf[i];
      const dp = cov.distinctOnly.perLeaf[i];
      if (fp.passed && !dp.passed) {
        regressions.push({ leafIndex: fp.leaf.index, fullMomentIndex: fp.momentIndex });
      }
    }
    if (regressions.length === 0) {
      console.log("  none — coverage holds through dedup, so it's real breadth not padding");
    } else {
      for (const r of regressions) {
        // Which cluster was the full-pass moment in (if any)?
        const cluster = cov.duplicateClusters.find((c) => r.fullMomentIndex !== null && c.indices.includes(r.fullMomentIndex));
        const clusterNote = cluster
          ? `cluster [${cluster.indices.join(", ")}] "${cluster.representative}" — kept #${Math.min(...cluster.indices)}, dropped moment used on full pass was #${r.fullMomentIndex}`
          : `full-pass moment #${r.fullMomentIndex} was not part of any cluster; regression is not a dedup artifact`;
        console.log(`  L${r.leafIndex}: ${clusterNote}`);
      }
    }
    console.log("");
    console.log("=== side-by-side ===");
    console.log(`  against all ${cov.momentCount} moments:              ${cov.full.covered}/${cov.total}`);
    console.log(`  against ${cov.distinctAfterCollapse} distinct-only moments:      ${cov.distinctOnly.covered}/${cov.total}`);
    if (regressions.length > 0) {
      console.log(`  regressions (full pass → distinct only): ${regressions.length}`);
    }
    // Hard-gate on the distinct-only score — that's the real breadth signal.
    if (cov.distinctOnly.covered < cov.total) process.exit(1);
    return;
  }
  if (cmd === "embed-backfill") {
    const result = await backfillMissingEmbeddings();
    console.log("");
    console.log("=== embed-backfill summary ===");
    console.log(`scanned (null in searchable scope): ${result.scanned}`);
    console.log(`embedded (vector + model written):  ${result.embedded}`);
    console.log(`failed (API or DB error, retry):    ${result.failed}`);
    console.log(`skipped (empty title AND summary):  ${result.skipped}`);
    console.log("");
    console.log(
      `after a clean run, remaining nulls in searchable scope should equal failed + skipped = ${result.failed + result.skipped}`,
    );
    console.log(
      "(this is the identity verification check 1 reads; run the null-count query to confirm)",
    );
    // Exit non-zero only on `failed`, which is retryable and should
    // clear on a subsequent run. `skipped` is surfaced in the printed
    // output above; it is deliberately NOT gated here — skipped rows
    // will never embed, and exiting non-zero on them would make this
    // command a permanent-red status that can't be cleared. The
    // remaining-null identity above is where an operator judges the
    // sweep's completeness.
    if (result.failed > 0) process.exit(2);
    return;
  }
  console.error(`unknown command: ${cmd}`);
  console.error(
    "usage: run.ts extract <recording_id> | collapse <recording_id> --run <uuid> | verify <recording_id> --run <uuid> --fathom <path> | parse-fathom <path> | embed-backfill",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
