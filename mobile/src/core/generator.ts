/**
 * Fast, deterministic crossword generator for KidsWord (Grades 1-6).
 *
 * Given the same vocabulary order and seed it produces identical grids
 * (pinned by tests/golden.test.ts against tests/fixtures/golden_puzzles.json).
 */
import type {
  Difficulty,
  Direction,
  GeneratedPuzzle,
  GradeBandCode,
  GradeBandSpec,
  Grid,
  PlacedWord,
  WordEntry
} from "./models";
import { GRADE_BANDS } from "./gradeBands";
import { fnv1aHex, SeededRNG } from "./rng";
import { clueLeaksAnswer, isSafeWord, validateGridSafety } from "./safety";

export const RELATED_THEMES: Record<string, string[]> = {
  animals: ["ocean", "nature", "science"],
  ocean: ["animals", "weather", "nature", "science"],
  space: ["science", "weather"],
  food: ["body", "nature"],
  feelings: ["body", "jobs"],
  weather: ["nature", "science", "ocean"],
  body: ["feelings", "food", "science"],
  jobs: ["science", "feelings"],
  science: ["space", "nature", "weather", "animals"],
  nature: ["animals", "weather", "ocean", "science"]
};

interface Placement {
  entry: WordEntry;
  row: number;
  col: number;
  direction: Direction;
}

interface BuildResult {
  grid: Grid;
  placements: Placement[];
  qualityScore: number;
}

type Bounds = [number, number, number, number];
type Move = [number, WordEntry, number, number, Direction];
type LetterPositions = Map<string, [number, number, Direction][]>;

export interface GenerateOptions {
  gradeBand?: string;
  theme?: string;
  difficulty?: string;
  seed?: string;
  recentWords?: readonly string[];
  customWords?: readonly WordEntry[] | null;
  restarts?: number;
}

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

function step(direction: Direction): [number, number] {
  return direction === "across" ? [0, 1] : [1, 0];
}

/** Python-compatible round(x, n) (round-half on exact binary value). */
function roundTo(x: number, digits: number): number {
  return Number(x.toFixed(digits));
}

export function formatClueForBand(entry: WordEntry, bandCode: string, difficulty: string): string {
  const base = entry.kid_definition.trim();
  if (bandCode === "G1_2") return entry.emoji ? `${entry.emoji} ${base}` : base;
  if (bandCode === "G3_4") {
    if (difficulty === "easy" && entry.example_sentence) return `${base} (${entry.example_sentence})`;
    return base;
  }
  const extras: string[] = [];
  if (entry.synonyms.length) extras.push(`Synonym: ${entry.synonyms[0]}`);
  else if (entry.antonyms.length) extras.push(`Opposite: ${entry.antonyms[0]}`);
  if (difficulty === "hard" && extras.length) return `${base} [${extras[0]}]`;
  if (extras.length && difficulty === "easy") return `${base} - ${extras[0]}`;
  return base;
}

export class CrosswordGenerator {
  readonly vocabulary: WordEntry[];

  constructor(vocabulary: readonly WordEntry[]) {
    this.vocabulary = vocabulary.filter(
      (w) =>
        !w.safety_flag &&
        w.review_status === "approved" &&
        isSafeWord(w.word) &&
        !clueLeaksAnswer(w.word, w.kid_definition)
    );
  }

  generate(options: GenerateOptions = {}): GeneratedPuzzle {
    const t0 = performance.now();
    const gradeBand = options.gradeBand ?? "G1_2";
    const spec = GRADE_BANDS[gradeBand as GradeBandCode] ?? GRADE_BANDS.G1_2;
    const rawDiff = (options.difficulty ?? "medium").toLowerCase();
    const difficulty: Difficulty = (DIFFICULTIES as readonly string[]).includes(rawDiff)
      ? (rawDiff as Difficulty)
      : "medium";
    const themeKey = (options.theme ?? "animals").trim().toLowerCase();
    const seed = options.seed ?? "default-seed";
    const restarts = options.restarts ?? 5;
    const recentSet = new Set((options.recentWords ?? []).map((w) => w.trim().toUpperCase()));

    const [primaryPool, fallbackPool] =
      options.customWords && options.customWords.length
        ? this.prepareCustomPool(options.customWords, spec)
        : this.selectCandidates(spec, themeKey, difficulty, recentSet);

    const targetWords = this.targetWordCount(spec, difficulty, primaryPool.length + fallbackPool.length);
    const gridLimit = this.targetGridSize(spec, difficulty);

    const rng = new SeededRNG(`${seed}:${gradeBand}:${themeKey}:${difficulty}`);
    let best: BuildResult | null = null;

    for (let attempt = 0; attempt < restarts; attempt++) {
      // Budget guard: keep total runtime well below 250ms on slow devices
      if (attempt > 0 && performance.now() - t0 > 180 && best !== null) break;

      const candidate = this.attemptBuild(primaryPool, fallbackPool, spec, gridLimit, targetWords, themeKey, rng, attempt);
      if (candidate) {
        if (best === null || candidate.qualityScore > best.qualityScore) best = candidate;
        if (candidate.qualityScore >= 0.82 && candidate.placements.length >= targetWords) break;
      }
    }

    if (best === null) {
      const maxGrade = Math.max(...spec.grades);
      const broadPool = this.vocabulary.filter(
        (w) => w.word.length >= spec.min_word_len && w.word.length <= spec.max_word_len && w.grade_level <= maxGrade
      );
      best = this.attemptBuild(
        [...primaryPool, ...fallbackPool],
        broadPool,
        spec,
        spec.max_grid,
        Math.max(2, spec.min_words - 1),
        themeKey,
        rng,
        99
      );
    }

    if (best === null) {
      throw new Error(`Unable to build valid crossword for band=${gradeBand}, theme=${themeKey}`);
    }

    return this.finalizePuzzle(best, seed, spec.code, themeKey, difficulty, rng, performance.now() - t0);
  }

  private prepareCustomPool(customWords: readonly WordEntry[], spec: GradeBandSpec): [WordEntry[], WordEntry[]] {
    const seen = new Set<string>();
    const valid: WordEntry[] = [];
    const maxLen = Math.max(12, spec.max_word_len);
    for (const w of customWords) {
      const wu = w.word.trim().toUpperCase();
      if (!seen.has(wu) && isSafeWord(wu) && wu.length >= 2 && wu.length <= maxLen) {
        seen.add(wu);
        valid.push(w);
      }
    }
    return [valid, []];
  }

  private selectCandidates(
    spec: GradeBandSpec,
    themeKey: string,
    difficulty: Difficulty,
    recentSet: Set<string>
  ): [WordEntry[], WordEntry[]] {
    const maxGrade = Math.max(...spec.grades);
    const minGrade = Math.min(...spec.grades);
    const primary: WordEntry[] = [];
    const related: WordEntry[] = [];
    const relatedThemes = new Set(RELATED_THEMES[themeKey] ?? []);

    for (const entry of this.vocabulary) {
      const wlen = entry.word.length;
      if (wlen < spec.min_word_len || wlen > spec.max_word_len) continue;
      if (entry.grade_level > maxGrade) continue;
      if (spec.code === "G5_6" && entry.grade_level < 3) continue;
      if (spec.code === "G3_4" && entry.grade_level < 2) continue;

      const entryThemes = entry.themes.map((t) => t.toLowerCase());
      if (themeKey === "all" || themeKey === "daily" || entryThemes.includes(themeKey)) {
        primary.push(entry);
      } else if (entryThemes.some((t) => relatedThemes.has(t)) || (difficulty === "hard" && entry.grade_level >= minGrade)) {
        related.push(entry);
      }
    }

    const sortAndDedupe = (items: WordEntry[]): WordEntry[] => {
      const byWord = new Map<string, WordEntry>();
      for (const item of items) {
        const wu = item.word.toUpperCase();
        if (!byWord.has(wu)) byWord.set(wu, item);
      }
      const fresh: WordEntry[] = [];
      const stale: WordEntry[] = [];
      for (const [wu, w] of byWord) (recentSet.has(wu) ? stale : fresh).push(w);
      return [...fresh, ...stale];
    };

    return [sortAndDedupe(primary), sortAndDedupe(related)];
  }

  private targetWordCount(spec: GradeBandSpec, difficulty: Difficulty, poolSize: number): number {
    let target: number;
    if (difficulty === "easy") target = spec.min_words;
    else if (difficulty === "medium") target = Math.floor((spec.min_words + spec.max_words) / 2);
    else target = spec.max_words;
    return Math.max(2, Math.min(target, poolSize));
  }

  private targetGridSize(spec: GradeBandSpec, difficulty: Difficulty): number {
    return difficulty === "easy" ? Math.max(spec.min_grid, spec.max_grid - 1) : spec.max_grid;
  }

  private attemptBuild(
    primaryPool: WordEntry[],
    fallbackPool: WordEntry[],
    spec: GradeBandSpec,
    gridLimit: number,
    targetWords: number,
    themeKey: string,
    rng: SeededRNG,
    attempt: number
  ): BuildResult | null {
    const shuffledPrimary = rng.shuffle(primaryPool);
    const shuffledFallback = rng.shuffle(fallbackPool);

    const anchorSource = shuffledPrimary.length ? shuffledPrimary.slice(0, 20) : shuffledFallback.slice(0, 20);
    if (!anchorSource.length) return null;

    // Keys are computed in list order (like Python's sorted(key=...)), then stable-sorted descending
    const keyed = anchorSource.map((w, idx) => {
      const letters = new Set(w.word.toUpperCase());
      let uniqueVowels = 0;
      for (const v of "AEIOU") if (letters.has(v)) uniqueVowels++;
      return { w, idx, key: w.word.length * 1.4 + uniqueVowels * 1.8 + rng.nextFloat() * 2.0 };
    });
    keyed.sort((a, b) => (b.key !== a.key ? b.key - a.key : a.idx - b.idx));
    const anchors = keyed.map((k) => k.w);

    const anchor = anchors[Math.min(attempt, anchors.length - 1)];
    const anchorWord = anchor.word.toUpperCase();
    const orderedPool = [
      ...shuffledPrimary.filter((w) => w.word.toUpperCase() !== anchorWord),
      ...shuffledFallback.filter((w) => w.word.toUpperCase() !== anchorWord)
    ];

    const canvasSize = gridLimit * 2 + 3;
    const grid: Grid = Array.from({ length: canvasSize }, () => new Array<string | null>(canvasSize).fill(null));
    const center = Math.floor(canvasSize / 2);

    const firstDir: Direction = attempt % 2 === 0 ? "across" : "down";
    const half = Math.floor(anchor.word.length / 2);
    const startR = firstDir === "across" ? center : center - half;
    const startC = firstDir === "across" ? center - half : center;

    const placements: Placement[] = [];
    const letterPositions: LetterPositions = new Map();
    this.placeWord(grid, anchor, startR, startC, firstDir, placements, letterPositions);
    const usedWords = new Set<string>([anchorWord]);

    this.fillWords(grid, placements, letterPositions, usedWords, orderedPool.slice(0, 55), gridLimit, targetWords, rng);

    const minAcceptable = Math.min(spec.min_words, Math.max(2, primaryPool.length + fallbackPool.length));
    if (placements.length < minAcceptable && placements.length < 3) return null;

    const cropped = this.cropAndNormalize(placements, spec.min_grid, gridLimit);
    if (!cropped) return null;
    const [croppedGrid, normPlacements] = cropped;

    if (!this.isFullyConnected(normPlacements)) return null;
    if (validateGridSafety(croppedGrid).length) return null;

    return {
      grid: croppedGrid,
      placements: normPlacements,
      qualityScore: this.scorePuzzle(croppedGrid, normPlacements, targetWords, themeKey)
    };
  }

  private fillWords(
    grid: Grid,
    placements: Placement[],
    letterPositions: LetterPositions,
    usedWords: Set<string>,
    pool: WordEntry[],
    gridLimit: number,
    targetWords: number,
    rng: SeededRNG
  ): void {
    while (placements.length < targetWords) {
      const acrossCount = placements.filter((p) => p.direction === "across").length;
      const preferredDir: Direction = acrossCount > placements.length - acrossCount ? "down" : "across";
      const curBounds = this.bounds(placements);
      const curArea = (curBounds[1] - curBounds[0] + 1) * (curBounds[3] - curBounds[2] + 1);

      let bestMove: Move | null = null;
      let evaluated = 0;

      for (const entry of pool) {
        if (usedWords.has(entry.word.toUpperCase())) continue;
        const move = this.bestMoveForWord(grid, entry, letterPositions, curBounds, curArea, gridLimit, preferredDir, rng);
        if (move) {
          evaluated++;
          if (bestMove === null || move[0] > bestMove[0]) bestMove = move;
          if (evaluated >= 18 && bestMove[0] >= 45.0) break;
        }
      }

      if (bestMove === null) break;
      const [, chosen, sr, sc, sdir] = bestMove;
      this.placeWord(grid, chosen, sr, sc, sdir, placements, letterPositions);
      usedWords.add(chosen.word.toUpperCase());
    }
  }

  private bestMoveForWord(
    grid: Grid,
    entry: WordEntry,
    letterPositions: LetterPositions,
    curBounds: Bounds,
    curArea: number,
    gridLimit: number,
    preferredDir: Direction,
    rng: SeededRNG
  ): Move | null {
    const word = entry.word.toUpperCase();
    let best: Move | null = null;
    const seen = new Set<string>();

    for (let idxNew = 0; idxNew < word.length; idxNew++) {
      const anchors = letterPositions.get(word[idxNew]);
      if (!anchors) continue;
      for (const [ar, ac, adir] of anchors) {
        const candDir: Direction = adir === "across" ? "down" : "across";
        const startR = candDir === "down" ? ar - idxNew : ar;
        const startC = candDir === "down" ? ac : ac - idxNew;
        const key = `${startR},${startC},${candDir}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const check = this.canPlace(grid, word, startR, startC, candDir, curBounds, gridLimit);
        if (!check) continue;
        const [crossings, newArea] = check;
        const areaDelta = Math.max(0, newArea - curArea);
        const dirBonus = candDir === preferredDir ? 6.0 : 0.0;
        const score = crossings * 26.0 - areaDelta * 1.4 + dirBonus + word.length * 0.8 + rng.nextFloat();
        if (best === null || score > best[0]) best = [score, entry, startR, startC, candDir];
      }
    }
    return best;
  }

  private canPlace(
    grid: Grid,
    word: string,
    row: number,
    col: number,
    direction: Direction,
    curBounds: Bounds,
    gridLimit: number
  ): [number, number] | null {
    const size = grid.length;
    const wlen = word.length;
    const [dr, dc] = step(direction);
    const endR = row + dr * (wlen - 1);
    const endC = col + dc * (wlen - 1);

    if (row < 1 || col < 1 || endR >= size - 1 || endC >= size - 1) return null;

    const [minR, maxR, minC, maxC] = curBounds;
    const newMinR = Math.min(row, minR);
    const newMaxR = Math.max(endR, maxR);
    const newMinC = Math.min(col, minC);
    const newMaxC = Math.max(endC, maxC);
    if (newMaxR - newMinR + 1 > gridLimit || newMaxC - newMinC + 1 > gridLimit) return null;

    if (grid[row - dr][col - dc] !== null || grid[endR + dr][endC + dc] !== null) return null;

    let crossings = 0;
    let newCells = 0;
    for (let i = 0; i < wlen; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const existing = grid[r][c];
      if (existing !== null) {
        if (existing !== word[i]) return null;
        // Must cross orthogonally, never overlap an inline word in the same direction
        const hasPerp =
          direction === "across"
            ? grid[r - 1][c] !== null || grid[r + 1][c] !== null
            : grid[r][c - 1] !== null || grid[r][c + 1] !== null;
        if (!hasPerp) return null;
        crossings++;
      } else {
        if (direction === "across") {
          if (grid[r - 1][c] !== null || grid[r + 1][c] !== null) return null;
        } else if (grid[r][c - 1] !== null || grid[r][c + 1] !== null) {
          return null;
        }
        newCells++;
      }
    }

    if (crossings === 0 || newCells === 0) return null;
    return [crossings, (newMaxR - newMinR + 1) * (newMaxC - newMinC + 1)];
  }

  private placeWord(
    grid: Grid,
    entry: WordEntry,
    row: number,
    col: number,
    direction: Direction,
    placements: Placement[],
    letterPositions: LetterPositions
  ): void {
    const word = entry.word.toUpperCase();
    const [dr, dc] = step(direction);
    for (let i = 0; i < word.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      grid[r][c] = word[i];
      let list = letterPositions.get(word[i]);
      if (!list) {
        list = [];
        letterPositions.set(word[i], list);
      }
      list.push([r, c, direction]);
    }
    placements.push({ entry, row, col, direction });
  }

  private bounds(placements: Placement[]): Bounds {
    let minR = 999999;
    let maxR = -999999;
    let minC = 999999;
    let maxC = -999999;
    for (const p of placements) {
      const wlen = p.entry.word.length;
      const r1 = p.row + (p.direction === "down" ? wlen - 1 : 0);
      const c1 = p.col + (p.direction === "across" ? wlen - 1 : 0);
      if (p.row < minR) minR = p.row;
      if (r1 > maxR) maxR = r1;
      if (p.col < minC) minC = p.col;
      if (c1 > maxC) maxC = c1;
    }
    return [minR, maxR, minC, maxC];
  }

  private cropAndNormalize(placements: Placement[], minGrid: number, maxGrid: number): [Grid, Placement[]] | null {
    const [minR, maxR, minC, maxC] = this.bounds(placements);
    const usedH = maxR - minR + 1;
    const usedW = maxC - minC + 1;
    if (usedH > maxGrid || usedW > maxGrid) return null;

    const side = Math.min(maxGrid, Math.max(minGrid, usedH, usedW));
    const padTop = Math.floor((side - usedH) / 2);
    const padLeft = Math.floor((side - usedW) / 2);

    const cropped: Grid = Array.from({ length: side }, () => new Array<string | null>(side).fill(null));
    const norm: Placement[] = [];
    for (const p of placements) {
      const nr = p.row - minR + padTop;
      const nc = p.col - minC + padLeft;
      const word = p.entry.word.toUpperCase();
      const [dr, dc] = step(p.direction);
      for (let i = 0; i < word.length; i++) cropped[nr + dr * i][nc + dc * i] = word[i];
      norm.push({ entry: p.entry, row: nr, col: nc, direction: p.direction });
    }
    return [cropped, norm];
  }

  private isFullyConnected(placements: Placement[]): boolean {
    if (placements.length <= 1) return true;
    const owners = new Map<string, number[]>();
    placements.forEach((p, idx) => {
      const [dr, dc] = step(p.direction);
      for (let i = 0; i < p.entry.word.length; i++) {
        const key = `${p.row + dr * i},${p.col + dc * i}`;
        const list = owners.get(key);
        if (list) list.push(idx);
        else owners.set(key, [idx]);
      }
    });

    const adj: Set<number>[] = placements.map(() => new Set<number>());
    for (const list of owners.values()) {
      if (list.length > 1) for (const a of list) for (const b of list) if (a !== b) adj[a].add(b);
    }

    const visited = new Set<number>([0]);
    const stack = [0];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nxt of adj[cur]) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return visited.size === placements.length;
  }

  private scorePuzzle(grid: Grid, placements: Placement[], targetWords: number, themeKey: string): number {
    const wordRatio = Math.min(1.0, placements.length / Math.max(1, targetWords));
    const cellCounts = new Map<string, number>();
    let themeHits = 0;

    for (const p of placements) {
      if (themeKey === "all" || themeKey === "daily" || p.entry.themes.some((t) => t.toLowerCase() === themeKey)) {
        themeHits++;
      }
      const [dr, dc] = step(p.direction);
      for (let i = 0; i < p.entry.word.length; i++) {
        const key = `${p.row + dr * i},${p.col + dc * i}`;
        cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
      }
    }

    let crossings = 0;
    for (const v of cellCounts.values()) if (v > 1) crossings++;
    const crossingRatio = Math.min(1.0, (crossings * 2.2) / Math.max(1, placements.length));
    const rows = grid.length;
    const cols = rows ? grid[0].length : 1;
    const density = Math.min(1.0, cellCounts.size / Math.max(1, rows * cols) / 0.4);
    const themePurity = themeHits / Math.max(1, placements.length);
    const across = placements.filter((p) => p.direction === "across").length;
    const balance = 1.0 - Math.abs(across - (placements.length - across)) / Math.max(1, placements.length);

    const score = 0.34 * wordRatio + 0.28 * crossingRatio + 0.16 * density + 0.12 * themePurity + 0.1 * balance;
    return roundTo(Math.min(1.0, Math.max(0.0, score)), 4);
  }

  private finalizePuzzle(
    best: BuildResult,
    seed: string,
    gradeBand: GradeBandCode,
    theme: string,
    difficulty: Difficulty,
    rng: SeededRNG,
    elapsedMs: number
  ): GeneratedPuzzle {
    const { grid, placements } = best;
    const rows = grid.length;
    const cols = rows ? grid[0].length : 0;

    const startsAt = new Map<string, Placement[]>();
    for (const p of placements) {
      const key = `${p.row},${p.col}`;
      const list = startsAt.get(key);
      if (list) list.push(p);
      else startsAt.set(key, [p]);
    }

    const numbers: (number | null)[][] = Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null));
    const prefilled: Grid = Array.from({ length: rows }, () => new Array<string | null>(cols).fill(null));
    const words: PlacedWord[] = [];
    let clueNum = 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const starts = startsAt.get(`${r},${c}`);
        if (!starts) continue;
        numbers[r][c] = clueNum;
        const ordered = starts
          .map((p, i) => ({ p, i }))
          .sort((a, b) => (a.p.direction === b.p.direction ? a.i - b.i : a.p.direction === "across" ? -1 : 1))
          .map((x) => x.p);

        for (const p of ordered) {
          const entry = p.entry;
          const wordUpper = entry.word.toUpperCase();
          let revealed: number[] = [];
          if (difficulty === "easy") {
            const revealCount = Math.max(1, Math.floor(wordUpper.length / 3));
            const indices = rng.shuffle(Array.from({ length: wordUpper.length }, (_, i) => i)).slice(0, revealCount);
            revealed = indices.sort((a, b) => a - b);
            const [dr, dc] = step(p.direction);
            for (const idx of revealed) prefilled[r + dr * idx][c + dc * idx] = wordUpper[idx];
          }
          words.push({
            number: clueNum,
            direction: p.direction,
            row: r,
            col: c,
            word: wordUpper,
            clue: formatClueForBand(entry, gradeBand, difficulty),
            example_sentence: entry.example_sentence,
            emoji: entry.emoji,
            grade_level: entry.grade_level,
            themes: [...entry.themes],
            part_of_speech: entry.part_of_speech,
            synonyms: [...entry.synonyms],
            antonyms: [...entry.antonyms],
            revealed_indices: revealed
          });
        }
        clueNum++;
      }
    }

    return {
      puzzle_id: `kw-${gradeBand.toLowerCase()}-${theme}-${fnv1aHex(`${seed}:${gradeBand}:${theme}:${difficulty}`)}`,
      seed,
      grade_band: gradeBand,
      theme,
      difficulty,
      rows,
      cols,
      grid,
      numbers,
      prefilled,
      words,
      quality_score: roundTo(best.qualityScore, 3),
      generation_ms: roundTo(elapsedMs, 2)
    };
  }
}
