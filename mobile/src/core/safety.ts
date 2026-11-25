import rules from "../data/safety_rules.json";
import type { Grid } from "./models";

export const BLOCKLIST: ReadonlySet<string> = new Set(rules.blocklist.map((w) => w.toUpperCase()));

/** True if word is alphabetic A-Z (2+ letters) and not on the child-safety blocklist. */
export function isSafeWord(word: string, extraBlocklist: Iterable<string> = []): boolean {
  const cleaned = word.trim().toUpperCase();
  if (cleaned.length < 2 || !/^[A-Z]+$/.test(cleaned)) return false;
  if (BLOCKLIST.has(cleaned)) return false;
  for (const extra of extraBlocklist) {
    if (extra.toUpperCase() === cleaned) return false;
  }
  return true;
}

/** True if clue text contains the answer as a whole word or a 4+ letter stem. */
export function clueLeaksAnswer(answer: string, clueText: string): boolean {
  const ans = answer.trim().toLowerCase();
  if (!ans) return false;
  const tokens = clueText.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const tok of tokens) {
    if (tok === ans) return true;
    if (ans.length >= 4 && (tok.startsWith(ans) || (ans.startsWith(tok) && tok.length >= 4))) return true;
  }
  return false;
}

function countSyllables(word: string): number {
  let w = word.toLowerCase();
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  w = w.replace(/^y/, "");
  const vowels = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, vowels ? vowels.length : 0);
}

/** Approximate Flesch-Kincaid grade level of a single clue. */
export function estimateGradeReadability(text: string): number {
  const words = text.match(/[a-zA-Z]+/g) ?? [];
  if (words.length === 0) return 1.0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const fk = 0.39 * Math.max(1, words.length) + 11.8 * (syllables / words.length) - 15.59;
  return Math.round(Math.max(1.0, Math.min(8.0, fk)) * 10) / 10;
}

/** Scan every horizontal and vertical run for blocked fragments. */
export function validateGridSafety(grid: Grid): string[] {
  const violations: string[] = [];
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;

  const flush = (run: string, label: string) => {
    if (run.length >= 2 && BLOCKLIST.has(run)) violations.push(`${label}: ${run}`);
  };

  for (let r = 0; r < rows; r++) {
    let run = "";
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      if (ch) run += ch.toUpperCase();
      else {
        flush(run, `Across(${r})`);
        run = "";
      }
    }
    flush(run, `Across(${r})`);
  }

  for (let c = 0; c < cols; c++) {
    let run = "";
    for (let r = 0; r < rows; r++) {
      const ch = grid[r][c];
      if (ch) run += ch.toUpperCase();
      else {
        flush(run, `Down(${c})`);
        run = "";
      }
    }
    flush(run, `Down(${c})`);
  }

  return violations;
}
