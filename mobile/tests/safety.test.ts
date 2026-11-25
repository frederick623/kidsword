import { describe, expect, it } from "vitest";
import { clueLeaksAnswer, estimateGradeReadability, isSafeWord, validateGridSafety } from "../src/core/safety";
import content from "../src/data/content.json";

describe("safety", () => {
  it("blocks unsafe and non-alphabetic words", () => {
    expect(isSafeWord("DAMN")).toBe(false);
    expect(isSafeWord("DOLPHIN")).toBe(true);
    expect(isSafeWord("CAT1")).toBe(false);
    expect(isSafeWord("<b>")).toBe(false);
    expect(isSafeWord("A")).toBe(false);
  });

  it("detects blocked fragments formed in grid runs", () => {
    const grid = [
      ["C", "A", "T", null],
      ["D", "A", "M", "N"],
      [null, "N", null, null],
      [null, "T", null, null]
    ];
    expect(validateGridSafety(grid).some((v) => v.includes("DAMN"))).toBe(true);
  });

  it("detects clue answer leaks", () => {
    expect(clueLeaksAnswer("RAIN", "Water that falls as raindrops")).toBe(true);
    expect(clueLeaksAnswer("CAT", "A soft pet that says meow")).toBe(false);
  });

  it("orders readability sensibly", () => {
    expect(estimateGradeReadability("A soft pet that says meow.")).toBeLessThan(
      estimateGradeReadability("Microscopic single-celled organisms responsible for fermentation and digestion.")
    );
  });

  it("ships only safe, leak-free, emoji-complete content", () => {
    expect(content.words.length).toBeGreaterThanOrEqual(260);
    for (const w of content.words) {
      expect(isSafeWord(w.word), w.word).toBe(true);
      expect(clueLeaksAnswer(w.word, w.kid_definition), w.word).toBe(false);
      expect(w.emoji).not.toMatch(/^\?*$/);
    }
    for (const t of content.themes) expect(t.emoji).not.toMatch(/^\?*$/);
  });
});

/** Integrity rules for src/data/content.json (the vocabulary source of truth). */
describe("content.json integrity", () => {
  const themeIds = new Set(content.themes.map((t) => t.id));

  it("has 10 uniquely identified themes", () => {
    expect(themeIds.size).toBe(10);
    expect(content.themes.length).toBe(10);
  });

  it("has unique, well-formed, approved word entries", () => {
    const seen = new Set<string>();
    for (const w of content.words) {
      expect(seen.has(w.word), `duplicate ${w.word}`).toBe(false);
      seen.add(w.word);
      expect(w.word, w.word).toMatch(/^[A-Z]{2,12}$/);
      expect([1, 2, 3, 4, 5, 6], w.word).toContain(w.grade_level);
      expect(w.themes.length, w.word).toBeGreaterThan(0);
      expect(w.themes.some((t) => themeIds.has(t)), `${w.word}: no playable theme`).toBe(true);
      expect(w.kid_definition.trim().length, w.word).toBeGreaterThan(0);
      expect(w.review_status, w.word).toBe("approved");
      expect(w.safety_flag, w.word).toBe(false);
    }
  });

  it("covers every theme and grade band with enough words", () => {
    for (const id of themeIds) expect(content.words.filter((w) => w.themes.includes(id)).length, id).toBeGreaterThanOrEqual(15);
    for (const [lo, hi] of [[1, 2], [3, 4], [5, 6]]) {
      expect(content.words.filter((w) => w.grade_level >= lo && w.grade_level <= hi).length).toBeGreaterThanOrEqual(40);
    }
  });

  it("ships valid sample classroom assignments", () => {
    for (const a of content.sample_assignments) {
      expect(a.code).toMatch(/^[A-Z0-9]{4,12}$/);
      expect(a.words.length).toBeGreaterThanOrEqual(3);
      for (const w of a.words) {
        expect(isSafeWord(w.word)).toBe(true);
        expect(clueLeaksAnswer(w.word, w.kid_definition)).toBe(false);
      }
    }
  });
});
