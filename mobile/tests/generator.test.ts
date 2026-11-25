import { describe, expect, it } from "vitest";
import content from "../src/data/content.json";
import { CrosswordGenerator } from "../src/core/generator";
import { GRADE_BANDS } from "../src/core/gradeBands";
import type { WordEntry } from "../src/core/models";
import { verifyPuzzleInvariants } from "./invariants";

const vocab = content.words as WordEntry[];
const gen = new CrosswordGenerator(vocab);
const BANDS = ["G1_2", "G3_4", "G5_6"] as const;
const DIFFS = ["easy", "medium", "hard"] as const;
const THEMES = content.themes.map((t) => t.id);

describe("CrosswordGenerator", () => {
  it("is deterministic for a given seed", () => {
    const a = gen.generate({ gradeBand: "G3_4", theme: "space", difficulty: "medium", seed: "daily-2026-04-20" });
    const b = gen.generate({ gradeBand: "G3_4", theme: "space", difficulty: "medium", seed: "daily-2026-04-20" });
    expect(a.grid).toEqual(b.grid);
    expect(a.words).toEqual(b.words);
    expect(a.puzzle_id).toBe(b.puzzle_id);
  });

  it("produces different puzzles for different seeds", () => {
    const a = gen.generate({ gradeBand: "G3_4", theme: "animals", seed: "one" });
    const b = gen.generate({ gradeBand: "G3_4", theme: "animals", seed: "two" });
    expect(a.words.map((w) => w.word)).not.toEqual(b.words.map((w) => w.word));
  });

  for (const band of BANDS) {
    it(`satisfies all invariants for ${band} across every theme and difficulty`, () => {
      for (const theme of THEMES) {
        for (const difficulty of DIFFS) {
          const p = gen.generate({ gradeBand: band, theme, difficulty, seed: `test-${band}-${theme}-${difficulty}` });
          expect(verifyPuzzleInvariants(p), `${band}/${theme}/${difficulty}`).toEqual([]);
          expect(p.generation_ms).toBeLessThan(500);
          if (difficulty === "easy") expect(p.prefilled.some((row) => row.some((c) => c !== null))).toBe(true);
          for (const w of p.words) expect(w.clue.toLowerCase()).not.toMatch(new RegExp(`\\b${w.word.toLowerCase()}\\b`));
        }
      }
    });
  }

  it("respects grade-band word limits", () => {
    const grade = new Map(vocab.map((w) => [w.word, w.grade_level]));
    for (const band of BANDS) {
      const spec = GRADE_BANDS[band];
      const p = gen.generate({ gradeBand: band, theme: "animals", difficulty: "medium", seed: `limits-${band}` });
      for (const w of p.words) {
        expect(grade.get(w.word)!).toBeLessThanOrEqual(Math.max(...spec.grades));
        expect(w.word.length).toBeGreaterThanOrEqual(spec.min_word_len);
        expect(w.word.length).toBeLessThanOrEqual(spec.max_word_len);
      }
    }
  });

  it("builds classroom puzzles from custom words only", () => {
    const custom = vocab.filter((w) => w.themes.includes("space") && w.word.length <= 7).slice(0, 8);
    const p = gen.generate({ gradeBand: "G3_4", theme: "classroom", seed: "class-X", customWords: custom });
    const allowed = new Set(custom.map((w) => w.word));
    expect(p.words.length).toBeGreaterThanOrEqual(3);
    for (const w of p.words) expect(allowed.has(w.word)).toBe(true);
    expect(verifyPuzzleInvariants(p)).toEqual([]);
  });

  it("keeps a stress run of 150 puzzles valid", () => {
    let worst = 0;
    for (let i = 0; i < 150; i++) {
      const band = BANDS[i % 3];
      const p = gen.generate({ gradeBand: band, theme: THEMES[i % THEMES.length], difficulty: DIFFS[i % 3], seed: `bench-${i}` });
      expect(verifyPuzzleInvariants(p)).toEqual([]);
      worst = Math.max(worst, p.generation_ms);
    }
    expect(worst).toBeLessThan(500);
  });
});
