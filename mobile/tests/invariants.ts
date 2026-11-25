import type { GeneratedPuzzle } from "../src/core/models";
import { validateGridSafety } from "../src/core/safety";

/** Hard validity invariants every generated puzzle must satisfy. */
export function verifyPuzzleInvariants(p: GeneratedPuzzle): string[] {
  const errors: string[] = [];
  const { rows, cols, grid } = p;
  if (!p.words.length) return ["No words placed"];

  const expected = new Set<string>();
  const owners = new Map<string, number[]>();
  const filled = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== null;

  p.words.forEach((w, idx) => {
    const dr = w.direction === "across" ? 0 : 1;
    const dc = w.direction === "across" ? 1 : 0;
    expected.add(`${w.direction},${w.row},${w.col},${w.word.length}`);
    if (filled(w.row - dr, w.col - dc)) errors.push(`Non-empty cell before ${w.word}`);
    if (filled(w.row + dr * w.word.length, w.col + dc * w.word.length)) errors.push(`Non-empty cell after ${w.word}`);
    [...w.word].forEach((ch, i) => {
      const r = w.row + dr * i;
      const c = w.col + dc * i;
      if (grid[r]?.[c] !== ch) errors.push(`Grid mismatch at (${r},${c}) for ${w.word}`);
      const key = `${r},${c}`;
      owners.set(key, [...(owners.get(key) ?? []), idx]);
    });
  });

  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (grid[r][c] !== null) {
        const start = c;
        while (c < cols && grid[r][c] !== null) c++;
        const len = c - start;
        if (len >= 2 && !expected.has(`across,${r},${start},${len}`)) errors.push(`Unintended across run r=${r} c=${start} len=${len}`);
      } else c++;
    }
  }
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      if (grid[r][c] !== null) {
        const start = r;
        while (r < rows && grid[r][c] !== null) r++;
        const len = r - start;
        if (len >= 2 && !expected.has(`down,${start},${c},${len}`)) errors.push(`Unintended down run r=${start} c=${c} len=${len}`);
      } else r++;
    }
  }

  if (p.words.length > 1) {
    const adj = p.words.map(() => new Set<number>());
    for (const list of owners.values()) for (const a of list) for (const b of list) if (a !== b) adj[a].add(b);
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) for (const n of adj[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
    if (seen.size !== p.words.length) errors.push("Puzzle is not a single connected component");
  }

  errors.push(...validateGridSafety(grid));
  const words = p.words.map((w) => w.word);
  if (new Set(words).size !== words.length) errors.push("Duplicate answer words");
  return errors;
}
