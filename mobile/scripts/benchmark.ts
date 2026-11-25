/**
 * Generator benchmark.
 *
 *   npm run bench               # 100 puzzles per grade band
 *   npm run bench -- --count 300
 */
import { performance } from "node:perf_hooks";
import content from "../src/data/content.json";
import { CrosswordGenerator } from "../src/core/generator";
import { GRADE_BANDS } from "../src/core/gradeBands";
import type { WordEntry } from "../src/core/models";
import { verifyPuzzleInvariants } from "../tests/invariants";

function parseCount(argv: string[]): number {
  const i = argv.indexOf("--count");
  const n = i >= 0 ? Number.parseInt(argv[i + 1] ?? "", 10) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, d: number) => Number(x.toFixed(d));

const count = parseCount(process.argv.slice(2));
const gen = new CrosswordGenerator(content.words as WordEntry[]);
const themes = content.themes.map((t) => t.id);
const difficulties = ["easy", "medium", "hard"];
let totalProblems = 0;

console.log(`=== KidsWord Generator Benchmark (${count} puzzles per band) ===`);
for (const band of Object.keys(GRADE_BANDS)) {
  const timings: number[] = [];
  const qualities: number[] = [];
  const wordCounts: number[] = [];
  let failures = 0;
  let invariantErrors = 0;

  for (let i = 0; i < count; i++) {
    const theme = themes[i % themes.length];
    const difficulty = difficulties[i % difficulties.length];
    const t0 = performance.now();
    try {
      const p = gen.generate({ gradeBand: band, theme, difficulty, seed: `bench-${band}-${theme}-${difficulty}-${i}` });
      timings.push(performance.now() - t0);
      qualities.push(p.quality_score);
      wordCounts.push(p.words.length);
      if (verifyPuzzleInvariants(p).length) invariantErrors++;
    } catch {
      failures++;
    }
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] : 0;
  totalProblems += failures + invariantErrors;
  console.log(
    `[${band}]`,
    JSON.stringify({
      generated: count - failures,
      failures,
      invariant_errors: invariantErrors,
      avg_ms: round(mean(timings), 2),
      p95_ms: round(p95, 2),
      max_ms: round(sorted.at(-1) ?? 0, 2),
      avg_quality: round(mean(qualities), 3),
      avg_words: round(mean(wordCounts), 2)
    })
  );
}

process.exitCode = totalProblems ? 1 : 0;
