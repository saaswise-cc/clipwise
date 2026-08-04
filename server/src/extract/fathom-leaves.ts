// Parse a Fathom summary markdown file into leaf-bullet claims under
// ## Topics. Excludes ## Key Takeaways (restates topics already counted)
// and ## Next Steps (commitments, a different extraction target).
//
// A bullet is a leaf iff no immediately-following bullet has greater
// indent depth before the next same-or-shallower sibling. Parents whose
// children replace their content (e.g. "Solution: ... will focus on:")
// are still parents; their leaves are what count.
//
// Callers get the leaf list plus the excluded non-leaf parents, so the
// denominator is visible in the harness output.

import { readFileSync } from "node:fs";

export type Bullet = {
  depth: number;
  text: string;
  section: string;
  lineNo: number;
};

export type Leaf = {
  index: number;
  section: string;
  depth: number;
  text: string;
};

const BULLET_RE = /^(\s*)- (.*)$/;
const H2_RE = /^## (.+)$/;
const H3_RE = /^### (.+)$/;

// Strip Fathom's markdown link syntax [text](url) and **bold** markers,
// leaving the plain claim.
function cleanClaim(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFathomLeaves(mdPath: string): {
  leaves: Leaf[];
  excludedParents: Bullet[];
  ignoredSections: string[];
} {
  const lines = readFileSync(mdPath, "utf8").split("\n");
  const bullets: Bullet[] = [];
  const ignoredSections: string[] = [];
  let currentH2 = "";
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(H2_RE);
    if (h2) {
      currentH2 = h2[1].trim();
      currentSection = currentH2;
      if (currentH2 !== "Topics") ignoredSections.push(currentH2);
      continue;
    }
    const h3 = line.match(H3_RE);
    if (h3 && currentH2 === "Topics") {
      currentSection = h3[1].trim();
      continue;
    }
    if (currentH2 !== "Topics") continue;
    const m = line.match(BULLET_RE);
    if (!m) continue;
    const depth = m[1].length;
    const text = cleanClaim(m[2]);
    if (text.length === 0) continue;
    bullets.push({ depth, text, section: currentSection, lineNo: i + 1 });
  }

  // A bullet is a leaf iff the next bullet in the same H3 section (in
  // document order) has depth <= its own. The final bullet in a section
  // is always a leaf.
  const leaves: Leaf[] = [];
  const excludedParents: Bullet[] = [];
  let leafIndex = 0;
  for (let i = 0; i < bullets.length; i++) {
    const cur = bullets[i];
    const next = bullets[i + 1];
    const isLeaf =
      !next || next.section !== cur.section || next.depth <= cur.depth;
    if (isLeaf) {
      leaves.push({
        index: leafIndex++,
        section: cur.section,
        depth: cur.depth,
        text: cur.text,
      });
    } else {
      excludedParents.push(cur);
    }
  }

  return { leaves, excludedParents, ignoredSections };
}
