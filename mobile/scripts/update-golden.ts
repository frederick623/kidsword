/**
 * Regenerate tests/fixtures/golden_puzzles.json from the current TypeScript generator.
 *
 * The golden file pins generator output (originally exported from the Python
 * engine) so that any change in puzzle layout is caught by tests/golden.test.ts.
 * Only run this when you change the generator ON PURPOSE:
 *
 *   npm run golden:update
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import content from "../src/data/content.json";
import { CrosswordGenerator } from "../src/core/generator";
import { GRADE_BANDS } from "../src/core/gradeBands";
import type { WordEntry } from "../src/core/models";

const gen = new CrosswordGenerator(content.words as WordEntry[]);
const themes = [...content.themes.map((t) => t.id), "daily"];
const cases = [];

for (const band of Object.keys(GRADE_BANDS)) {
  for (const theme of themes) {
    for (const difficulty of ["easy", "medium", "hard"]) {
      const seed = `parity-${band}-${theme}-${difficulty}`;
      const p = gen.generate({ gradeBand: band, theme, difficulty, seed, restarts: 5 });
      cases.push({
        args: { grade_band: band, theme, difficulty, seed },
        rows: p.rows,
        cols: p.cols,
        grid: p.grid,
        prefilled: p.prefilled,
        quality_score: p.quality_score,
        words: p.words.map(({ number, direction, row, col, word, clue, revealed_indices }) => ({
          number,
          direction,
          row,
          col,
          word,
          clue,
          revealed_indices
        }))
      });
    }
  }
}

const target = fileURLToPath(new URL("../tests/fixtures/golden_puzzles.json", import.meta.url));
// ASCII-only JSON (emoji escaped) to stay safe with Windows code pages
const json = JSON.stringify({ cases }, null, 1).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(target, json + "\n", "ascii");
console.log(`Wrote ${cases.length} golden puzzles -> tests/fixtures/golden_puzzles.json`);
