# KidsWord - Word Worlds Crossword (Grades 1-6)

Playful, kid-safe, fully offline crossword app (**TypeScript + Vite + Capacitor**, Android & iOS) tailored for elementary students in **Grades 1-6** (ages 6-12), parents, and classroom teachers.

---

## Features Implemented

1. **Grade-Banded Crossword Progression**
   - **Grades 1-2 (`G1_2`)**: 5x5 to 7x7 grids, 3-5 letter words, 4-6 words, picture emoji + spoken TTS audio clues.
   - **Grades 3-4 (`G3_4`)**: 8x8 to 10x10 grids, 4-7 letter words, 6-10 words, kid-friendly definitions + fill-in-the-blank context sentences.
   - **Grades 5-6 (`G5_6`)**: 10x10 to 13x13 grids, 5-10 letter words, 10-16 words, definitions + synonyms/antonyms.
   - **3 Difficulty Tiers**: Easy (starter pre-revealed letters), Medium, and Challenge.

2. **10 Themed Word Worlds & Mascot Guides**
   - Animal Kingdom, Deep Ocean, Cosmic Space, Yummy Kitchen, Heart & Feelings, Sky & Weather, Science Lab, Green Forest, Amazing Body, and Community Heroes (375 curated words in `mobile/src/data/content.json`).

3. **Fast, Deterministic Crossword Engine (<50ms p95)**
   - Deterministic algorithm (`FNV-1a` + `Mulberry32` PRNG) in `mobile/src/core/generator.ts`; see [docs/GENERATOR_SPEC.md](docs/GENERATOR_SPEC.md).
   - Enforces single connected component, zero unintended 2-letter side-by-side fragments, clue numbering in reading order, and full horizontal/vertical safety blocklist scanning.

4. **Child-First Gameplay, Hints & Word Collection**
   - Large tap-friendly cells, custom uppercase A-Z on-screen keyboard + physical keyboard navigation, native offline TTS (`@capacitor-community/text-to-speech`, Web Speech fallback in the browser) for read-aloud clues.
   - **Accessibility**: Dyslexia-friendly spacing toggle (`Aa Font`) and Color-Blind Safe high-contrast palette (`High-Contrast`).
   - **Star Economy & Hints**: Reveal Letter (2 stars), Check Word (1 star), Reveal Word (5 stars), plus completion celebration modal.
   - **My Word Book**: Collectible word cards with mastery stars and spaced-repetition review mode (`Practice Review Words`).

5. **100% Offline, No Server**
   - Generator, vocabulary, safety rules and progress all live on-device (Capacitor Preferences; `localStorage` in the browser). The Android manifest declares no INTERNET permission.

6. **COPPA / GDPR-K Privacy Gate, Parent Summary, Teacher Assignments & Educator Studio**
   - Adult multiplication gate protecting the Grown-Ups dashboard.
   - Nickname-only child profiles (zero PII, zero ads, zero external trackers).
   - **Teacher Classroom Mode**: Create custom word lists and share them as offline **share codes** (`KW1.` + base64url, re-validated on import). Built-in sample code `SPACE1`.
   - **Word Studio**: Add/update words on the device with automated safety blocklist, answer-leak detection, and readability estimation.

---

## Quick Start (Node 20+, no Python needed)

```powershell
cd mobile
npm install            # behind a TLS-inspecting proxy: add --registry=<internal mirror> --cafile=<corporate CA>
npm run dev            # play locally at http://localhost:5173
npm test               # Vitest: golden puzzles, invariants, safety, content integrity, game service
npm run bench          # generator benchmark (default 100 puzzles per band; --count N)
npm run build          # type-check + production bundle in dist/
npm run preview        # serve the production bundle locally
```

### Project layout (`mobile/`)

| Path | Purpose |
|---|---|
| `src/core/` | Generator, PRNG, grade bands, safety checks |
| `src/services/` | Game logic (`gameService.ts`), storage, TTS, share codes |
| `src/ui/` | DOM UI (all dynamic text via `textContent`) |
| `src/data/content.json` | **Vocabulary source of truth** (words, themes, grade bands, sample assignments) |
| `src/data/safety_rules.json` | Safety blocklist |
| `scripts/` | `benchmark.ts`, `update-golden.ts` (run with `tsx`) |
| `tests/` | Vitest suites + `fixtures/golden_puzzles.json` |

### Editing vocabulary

Edit `src/data/content.json` directly (keep the file ASCII; escape emoji as `\uXXXX`). `npm test` validates every entry (unique A-Z words, grades 1-6, known themes, approved, safe, minimum words per theme/band). If you intentionally change generator output, refresh the regression fixtures with:

```powershell
npm run golden:update
```

### Native builds
```powershell
npm run cap:sync       # build + copy dist/ into android/ and ios/
npm run cap:android    # opens Android Studio (build APK/AAB there)
npm run cap:ios        # opens Xcode (macOS only)
```

Privacy: the Android manifest declares **no INTERNET permission**, and all progress lives in on-device storage under a nickname only.
Teachers create a list in Grown-Ups, then send the generated share code to students (message, printed sheet, QR). Students paste it into **Class Code** and get the same deterministic puzzle.
