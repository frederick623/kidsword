# Technical Specification: KidsWord Crossword Generation Engine

## 1. Overview
The crossword engine generates age-appropriate, connected, American-style free-form crossword grids for Grades 1-6. It runs fully on-device and deterministically from a seed, implemented in TypeScript at `mobile/src/core/generator.ts` (safety checks in `mobile/src/core/safety.ts`, blocklist in `mobile/src/data/safety_rules.json`). Regression is guarded by 99 golden fixtures (`mobile/tests/fixtures/golden_puzzles.json`) and the benchmark harness `mobile/scripts/benchmark.ts`.

## 2. Constraints & Grade Band Rules

| Grade Band | Grid Bounds | Word Length | Target Words | Clue Modalities |
|---|---|---|---|---|
| `G1_2` (Grades 1-2) | 5x5 to 7x7 | 3-5 letters | 4-6 | Emoji/SVG picture + spoken clue + short definition |
| `G3_4` (Grades 3-4) | 8x8 to 10x10 | 4-7 letters | 6-10 | Kid-friendly definition + fill-in-the-blank sentence |
| `G5_6` (Grades 5-6) | 10x10 to 13x13 | 5-10 letters | 10-16 | Definition + synonyms/antonyms + light wordplay |

### Difficulty Modifiers
- **Easy**: Pre-reveals ~25-35% of letters; strictly uses primary theme words with lower difficulty scores.
- **Medium**: No pre-revealed letters; uses theme words matching the grade band.
- **Hard**: Higher target crossing density, includes higher difficulty words and cross-theme stretch vocabulary when needed.

## 3. Hard Validity Invariants
1. **Single Connected Component**: Every placed word must belong to the single connected graph of words via valid orthogonal intersections.
2. **No Unintended Adjacency**:
   - Cells immediately preceding the start or following the end of a word along its axis must be empty or out of bounds.
   - Any perpendicular neighbor to a non-crossing cell must be empty (preventing accidental 2-letter fragments or invalid side-by-side words).
3. **Content & Blocklist Safety**:
   - Every word is approved (`review_status === "approved"` and `safety_flag === false`).
   - All contiguous horizontal/vertical runs of length $\ge 2$ and grid substrings are checked against the safety blocklist.
   - Clues are validated to never contain the answer word itself.
4. **Deterministic Seeded PRNG**:
   - Uses `mulberry32` seeded via FNV-1a string hashing so identical seeds (`daily-2026-11-24-G3_4`, classroom codes) produce identical layouts.

## 4. Generation Algorithm
1. **Candidate Filtering**:
   - Filter approved vocabulary by grade band, word length bounds, and theme.
   - Deprioritize `recentWords` seen by the child; if theme pool is small, gracefully fall back to related themes.
2. **Multi-Candidate Backtracking Search**:
   - Run $K$ seeded restarts (e.g., $K = 8$).
   - Anchor word selection favors high letter-intersection potential and length near the upper bound of the grade band, placed near the center.
   - Iteratively score all legal intersections for remaining words:
     $$\text{PlacementScore} = 25 \cdot N_{\text{crossings}} - 1.5 \cdot \Delta_{\text{area}} + 6 \cdot \text{BalanceBonus} - 0.8 \cdot \text{CenterDist}$$
   - Recurse/backtrack when placement stalls before reaching minimum word count.
3. **Grid Normalization & Clue Numbering**:
   - Crop or center within target `max_size` bounds.
   - Scan top-to-bottom, left-to-right assigning standard crossword numbers `1..N` to any cell that starts an Across and/or Down word.
4. **Quality Score Calculation**:
   $$\text{QualityScore} = 0.35 \cdot \text{WordRatio} + 0.30 \cdot \text{CrossingRatio} + 0.20 \cdot \text{Compactness} + 0.15 \cdot \text{ThemePurity}$$
   Keep the highest-scoring valid grid; if all restarts fail, make one final attempt with a broadened grade-appropriate pool and the maximum grid size.
