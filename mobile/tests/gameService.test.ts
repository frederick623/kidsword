import { beforeEach, describe, expect, it } from "vitest";
import { GameService, STATE_KEY } from "../src/services/gameService";
import { decodeShareCode, encodeShareCode, SHARE_PREFIX } from "../src/services/shareCode";
import { MemoryStore } from "../src/services/storage";
import { verifyPuzzleInvariants } from "./invariants";

const HOUR = 3_600_000;

describe("GameService (offline)", () => {
  let store: MemoryStore;
  let clock: number;
  let game: GameService;

  beforeEach(async () => {
    store = new MemoryStore();
    clock = Date.UTC(2026, 3, 20, 9, 0, 0);
    game = new GameService(store, undefined, () => clock);
    await game.init();
  });

  it("creates an anonymous profile with only a nickname", () => {
    const p = game.getProfile();
    expect(p.profile_id).toMatch(/^kid-[a-z0-9]{10}$/);
    expect(p.stars).toBe(20);
    expect(p.collection).toEqual([]);
  });

  it("lists all themes with word counts", () => {
    const themes = game.getThemes();
    expect(themes).toHaveLength(10);
    for (const t of themes) expect(t.word_count).toBeGreaterThan(0);
  });

  it("awards stars, tracks mastery and schedules spaced review", async () => {
    const puzzle = await game.generatePuzzle({ mode: "adventure", theme: "animals", gradeBand: "G1_2", difficulty: "easy", seed: "s1" });
    expect(verifyPuzzleInvariants(puzzle)).toEqual([]);
    const words = puzzle.words.map((w) => w.word);

    const res = await game.recordCompletion({
      puzzle_id: puzzle.puzzle_id,
      grade_band: "G1_2",
      theme: "animals",
      difficulty: "easy",
      solved_words: words,
      hinted_words: [words[0]],
      hints_used: 1,
      stars_spent: 2,
      duration_sec: 60
    });
    expect(res.stars_earned).toBe(6);
    expect(res.stars).toBe(20 + 6 - 2);
    expect(res.puzzles_completed).toBe(1);
    expect(res.collection).toHaveLength(words.length);
    const hinted = res.collection.find((c) => c.word === words[0])!;
    const clean = res.collection.find((c) => c.word === words[1])!;
    expect(hinted.mastery_level).toBe(1);
    expect(clean.mastery_level).toBe(2);
    expect(res.hard_words.map((h) => h.word)).toContain(words[0]);
    expect(res.due_review_words).toEqual([]);

    clock += 5 * HOUR; // hinted word (4h interval) becomes due, clean word (24h) not yet
    expect(game.getProfile().due_review_words).toEqual([words[0]]);

    clock += 24 * HOUR;
    expect(game.getProfile().due_review_words.length).toBe(words.length);
  });

  it("gives a no-hint bonus and caps mastery at 5", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await game.recordCompletion({
        puzzle_id: `p${i}`,
        grade_band: "G3_4",
        theme: "space",
        difficulty: "hard",
        solved_words: ["PLANET", "COMET", "ORBIT"],
        hinted_words: [],
        hints_used: 0,
        stars_spent: 0,
        duration_sec: 30
      });
      last = r.collection.find((c) => c.word === "PLANET")!.mastery_level;
      expect(r.stars_earned).toBe(15);
    }
    expect(last).toBe(5);
  });

  it("persists state across app restarts", async () => {
    await game.updateProfile({ nickname: "Owl<script>", dyslexia_font: true });
    const reopened = new GameService(store, undefined, () => clock);
    await reopened.init();
    const p = reopened.getProfile();
    expect(p.nickname).toBe("Owlscript");
    expect(p.dyslexia_font).toBe(true);
  });

  it("recovers from corrupted storage", async () => {
    await store.set(STATE_KEY, "{not json");
    const g = new GameService(store, undefined, () => clock);
    await g.init();
    expect(g.getProfile().stars).toBe(20);
  });

  it("falls back to a mixed puzzle when too few review words are due", async () => {
    const p = await game.generatePuzzle({ mode: "review", gradeBand: "G3_4" });
    expect(p.theme).toBe("all");
    expect(p.notice).toBeTruthy();
  });

  it("builds review puzzles from due words", async () => {
    const seedPuzzle = await game.generatePuzzle({ mode: "adventure", theme: "ocean", gradeBand: "G3_4", seed: "r" });
    await game.recordCompletion({
      puzzle_id: seedPuzzle.puzzle_id,
      grade_band: "G3_4",
      theme: "ocean",
      difficulty: "medium",
      solved_words: seedPuzzle.words.map((w) => w.word),
      hinted_words: [],
      hints_used: 0,
      stars_spent: 0,
      duration_sec: 40
    });
    clock += 48 * HOUR;
    const review = await game.generatePuzzle({ mode: "review", gradeBand: "G3_4" });
    expect(review.theme).toBe("review");
    expect(verifyPuzzleInvariants(review)).toEqual([]);
  });

  it("daily puzzle is identical for the same local day", async () => {
    const a = await game.generatePuzzle({ mode: "daily", gradeBand: "G1_2" });
    const b = await game.generatePuzzle({ mode: "daily", gradeBand: "G1_2" });
    expect(a.grid).toEqual(b.grid);
    clock += 24 * HOUR;
    const c = await game.generatePuzzle({ mode: "daily", gradeBand: "G1_2" });
    expect(c.seed).not.toBe(a.seed);
  });

  it("plays the bundled SPACE1 sample assignment", async () => {
    const p = await game.generatePuzzle({ mode: "classroom", assignmentCode: " space1 " });
    expect(p.assignment?.code).toBe("SPACE1");
    expect(verifyPuzzleInvariants(p)).toEqual([]);
  });

  it("rejects unknown classroom codes", async () => {
    await expect(game.generatePuzzle({ mode: "classroom", assignmentCode: "NOPE99" })).rejects.toThrow(/not found/);
  });

  describe("classroom share codes", () => {
    const words = [
      { word: "forest", clue: "A large woodland filled with tall trees" },
      { word: "RIVER", clue: "Fresh water flowing toward the sea" },
      { word: "OTTER", clue: "Playful swimmer that floats on its back" },
      { word: "ACORN", clue: "Nut that falls from an oak tree" }
    ];

    it("creates, exports and imports on another device", async () => {
      const created = await game.createAssignment({ title: "Forest", teacher_label: "Ms. Lin", grade_band: "G3_4", words });
      expect(created.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(created.share_code.startsWith(SHARE_PREFIX)).toBe(true);

      const student = new GameService(new MemoryStore(), undefined, () => clock);
      await student.init();
      const p = await student.generatePuzzle({ mode: "classroom", assignmentCode: created.share_code });
      expect(p.assignment?.code).toBe(created.code);
      expect(p.words.length).toBeGreaterThanOrEqual(3);
      for (const w of p.words) expect(["FOREST", "RIVER", "OTTER", "ACORN"]).toContain(w.word);

      // Teacher and student produce the same deterministic grid
      const teacherPuzzle = await game.generatePuzzle({ mode: "classroom", assignmentCode: created.code });
      expect(p.grid).toEqual(teacherPuzzle.grid);

      // After import, the short code works on the student device too
      expect(student.listAssignments().some((a) => a.code === created.code)).toBe(true);
    });

    it("rejects unsafe words, answer leaks and too few words", async () => {
      await expect(game.createAssignment({ words: [...words.slice(0, 2), { word: "DAMN", clue: "bad" }] })).rejects.toThrow(/safety/);
      await expect(game.createAssignment({ words: [...words.slice(0, 2), { word: "MOSS", clue: "Mossy green plant" }] })).rejects.toThrow(/answer/);
      await expect(game.createAssignment({ words: words.slice(0, 2) })).rejects.toThrow(/at least 3/);
    });

    it("re-validates tampered share codes on import", async () => {
      const forged = encodeShareCode({
        code: "EVIL01",
        title: "x",
        teacher_label: "y",
        grade_band: "G3_4",
        difficulty: "medium",
        words: [...words.slice(0, 3), { word: "DAMN", clue: "not allowed" }]
      });
      await expect(game.importShareCode(forged)).rejects.toThrow(/safety/);
      await expect(game.importShareCode(`${SHARE_PREFIX}@@@`)).rejects.toThrow(/damaged/);
      await expect(game.importShareCode(SHARE_PREFIX + "A".repeat(7000))).rejects.toThrow(/too long/);
      expect(() => decodeShareCode("hello")).toThrow();
    });

    it("keeps markup in clues as inert text", async () => {
      const created = await game.createAssignment({
        words: [...words.slice(0, 3), { word: "MOSS", clue: "<img src=x onerror=alert(1)> green carpet" }]
      });
      const p = await game.generatePuzzle({ mode: "classroom", assignmentCode: created.code });
      const moss = p.words.find((w) => w.word === "MOSS");
      if (moss) expect(moss.clue).toContain("<img"); // stored verbatim; UI renders via textContent only
    });
  });

  describe("word studio", () => {
    it("adds a custom word that appears in themed puzzles", async () => {
      const res = await game.upsertWord({
        word: "compass",
        grade_level: 4,
        themes: "science,nature",
        kid_definition: "A magnetic tool with a needle that points north.",
        example_sentence: "Hikers used a ___ to find north.",
        emoji: "\u{1F9ED}"
      });
      expect(res).toMatchObject({ word: "COMPASS", version: 1, safety_flag: false, review_status: "approved" });
      expect(game.vocabulary().some((w) => w.word === "COMPASS")).toBe(true);

      const again = await game.upsertWord({ word: "COMPASS", kid_definition: "Tool that shows which way is north." });
      expect(again.version).toBe(2);
    });

    it("rejects invalid, leaking and flags unsafe words", async () => {
      await expect(game.upsertWord({ word: "C4T", kid_definition: "pet" })).rejects.toThrow(/A-Z/);
      await expect(game.upsertWord({ word: "SNOW", kid_definition: "Snowy flakes" })).rejects.toThrow(/answer/);
      const bad = await game.upsertWord({ word: "DAMN", kid_definition: "not for kids" });
      expect(bad.review_status).toBe("rejected");
      expect(game.getThemes().length).toBe(10);
    });
  });
});
