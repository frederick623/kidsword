import { describe, expect, it } from "vitest";
import content from "../src/data/content.json";
import { CrosswordGenerator } from "../src/core/generator";
import type { WordEntry } from "../src/core/models";
import golden from "./fixtures/golden_puzzles.json";

/**
 * Snapshot of generator output (originally exported from the reference Python
 * engine). Layout changes fail here; if intentional, run `npm run golden:update`.
 */
interface GoldenCase {
  args: { grade_band: string; theme: string; difficulty: string; seed: string };
  rows: number;
  cols: number;
  grid: (string | null)[][];
  prefilled: (string | null)[][];
  quality_score: number;
  words: { number: number; direction: string; row: number; col: number; word: string; clue: string; revealed_indices: number[] }[];
}

const gen = new CrosswordGenerator(content.words as WordEntry[]);
const cases = (golden as { cases: GoldenCase[] }).cases;

describe("generator golden puzzles", () => {
  it("has fixture cases", () => {
    expect(cases.length).toBe(99);
  });

  it.each(cases.map((c) => [c.args.seed, c] as const))("%s", (_seed, c) => {
    const p = gen.generate({
      gradeBand: c.args.grade_band,
      theme: c.args.theme,
      difficulty: c.args.difficulty,
      seed: c.args.seed,
      restarts: 5
    });
    expect([p.rows, p.cols]).toEqual([c.rows, c.cols]);
    expect(p.grid).toEqual(c.grid);
    expect(p.prefilled).toEqual(c.prefilled);
    expect(
      p.words.map(({ number, direction, row, col, word, clue, revealed_indices }) => ({
        number,
        direction,
        row,
        col,
        word,
        clue,
        revealed_indices
      }))
    ).toEqual(c.words);
    expect(Math.abs(p.quality_score - c.quality_score)).toBeLessThan(1e-3);
  });
});
