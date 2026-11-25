/**
 * Local, fully offline game service. All progress stays on the device.
 *
 * Privacy by design (COPPA / GDPR-K): the profile stores only a random opaque
 * id and a child-chosen nickname. No network calls are made.
 */
import bundledContent from "../data/content.json";
import { CrosswordGenerator } from "../core/generator";
import { GRADE_BANDS } from "../core/gradeBands";
import type {
  AssignmentRecord,
  Difficulty,
  GeneratedPuzzle,
  GradeBandCode,
  PuzzleMode,
  ThemeMeta,
  WordEntry
} from "../core/models";
import { clueLeaksAnswer, estimateGradeReadability, isSafeWord } from "../core/safety";
import type { KeyValueStore } from "./storage";
import { decodeShareCode, encodeShareCode, isShareCode, MAX_ASSIGNMENT_WORDS, MAX_CLUE_LENGTH } from "./shareCode";

export const STATE_KEY = "kidsword.state.v1";
const MAX_ATTEMPTS_KEPT = 100;
const REVIEW_INTERVAL_HOURS = [4, 24, 72, 168, 336];
const HOUR_MS = 3_600_000;

export interface ContentBundle {
  version: number;
  themes: ThemeMeta[];
  words: WordEntry[];
  sample_assignments: AssignmentRecord[];
}

interface ProfileRecord {
  profile_id: string;
  nickname: string;
  grade_band: GradeBandCode;
  stars: number;
  puzzles_completed: number;
  dyslexia_font: boolean;
  colorblind_mode: boolean;
  created_at: number;
}

interface WordProgress {
  times_solved: number;
  times_hinted: number;
  mastery_level: number;
  next_review_at: number;
  last_seen_at: number;
}

export interface AttemptRecord {
  attempt_id: string;
  puzzle_id: string;
  grade_band: string;
  theme: string;
  difficulty: string;
  words_count: number;
  hints_used: number;
  duration_sec: number;
  stars_earned: number;
  completed_at: number;
}

interface PersistedState {
  version: 1;
  profile: ProfileRecord;
  progress: Record<string, WordProgress>;
  attempts: AttemptRecord[];
  assignments: AssignmentRecord[];
  custom_words: WordEntry[];
}

export interface CollectionItem {
  word: string;
  times_solved: number;
  times_hinted: number;
  mastery_level: number;
  due_for_review: boolean;
  kid_definition: string;
  emoji: string;
  grade_level: number;
  example_sentence: string;
  themes: string[];
}

export interface ProfileView {
  profile_id: string;
  nickname: string;
  grade_band: GradeBandCode;
  stars: number;
  puzzles_completed: number;
  dyslexia_font: boolean;
  colorblind_mode: boolean;
  collection: CollectionItem[];
  hard_words: CollectionItem[];
  due_review_words: string[];
  recent_attempts: AttemptRecord[];
}

export interface ThemeSummary extends ThemeMeta {
  word_count: number;
}

export interface AssignmentSummary {
  code: string;
  title: string;
  teacher_label: string;
  grade_band: GradeBandCode;
  difficulty: Difficulty;
  word_count: number;
}

export interface PuzzleRequest {
  mode?: PuzzleMode;
  theme?: string;
  gradeBand?: GradeBandCode;
  difficulty?: Difficulty;
  seed?: string;
  assignmentCode?: string;
}

export interface CompletionPayload {
  puzzle_id: string;
  grade_band: string;
  theme: string;
  difficulty: string;
  solved_words: string[];
  hinted_words: string[];
  hints_used: number;
  stars_spent: number;
  duration_sec: number;
}

export interface AssignmentInput {
  title?: string;
  teacher_label?: string;
  grade_band?: string;
  difficulty?: string;
  words: { word: string; clue: string }[];
}

export interface WordInput {
  word: string;
  grade_level?: number;
  themes?: string | string[];
  part_of_speech?: string;
  kid_definition: string;
  example_sentence?: string;
  emoji?: string;
  synonyms?: string | string[];
  antonyms?: string | string[];
}

export interface UpsertWordResult {
  word: string;
  version: number;
  safety_flag: boolean;
  review_status: string;
  estimated_readability_grade: number;
}

function randomId(length: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function splitList(value: string | string[] | undefined, lower = false): string[] {
  const items = Array.isArray(value) ? value : (value ?? "").split(",");
  return items.map((s) => (lower ? s.trim().toLowerCase() : s.trim())).filter(Boolean);
}

function cleanNickname(nickname: string): string {
  return nickname.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 20) || "Explorer";
}

function localIsoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class GameService {
  private state!: PersistedState;
  private generator: CrosswordGenerator | null = null;
  private vocabCache: WordEntry[] | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly content: ContentBundle = bundledContent as ContentBundle,
    private readonly now: () => number = () => Date.now()
  ) {}

  async init(): Promise<void> {
    const raw = await this.store.get(STATE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed && parsed.version === 1 && parsed.profile) {
          this.state = parsed;
          return;
        }
      } catch {
        // Corrupted state: start fresh rather than crash a child's app
      }
    }
    this.state = {
      version: 1,
      profile: {
        profile_id: `kid-${randomId(10, "abcdefghijklmnopqrstuvwxyz0123456789")}`,
        nickname: "StarExplorer",
        grade_band: "G1_2",
        stars: 20,
        puzzles_completed: 0,
        dyslexia_font: false,
        colorblind_mode: false,
        created_at: this.now()
      },
      progress: {},
      attempts: [],
      assignments: [],
      custom_words: []
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.set(STATE_KEY, JSON.stringify(this.state));
  }

  // ---------------------------------------------------------------- vocabulary

  /** Bundled seed words with educator-added words layered on top (by word). */
  vocabulary(): WordEntry[] {
    if (!this.vocabCache) {
      const custom = new Map(this.state.custom_words.map((w) => [w.word, w]));
      const merged = this.content.words.map((w) => custom.get(w.word) ?? w);
      const seedSet = new Set(this.content.words.map((w) => w.word));
      for (const w of this.state.custom_words) if (!seedSet.has(w.word)) merged.push(w);
      this.vocabCache = merged;
    }
    return this.vocabCache;
  }

  private getGenerator(): CrosswordGenerator {
    if (!this.generator) this.generator = new CrosswordGenerator(this.vocabulary());
    return this.generator;
  }

  getThemes(): ThemeSummary[] {
    const counts = new Map<string, number>();
    for (const w of this.vocabulary()) {
      if (w.review_status !== "approved") continue;
      for (const t of w.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return this.content.themes.map((t) => ({ ...t, word_count: counts.get(t.id) ?? 0 }));
  }

  // ---------------------------------------------------------------- profile

  getProfile(): ProfileView {
    const p = this.state.profile;
    const now = this.now();
    const lookup = this.wordLookup();

    const entries = Object.entries(this.state.progress).sort((a, b) => b[1].last_seen_at - a[1].last_seen_at);
    const collection: CollectionItem[] = [];
    const hard: CollectionItem[] = [];
    const due: string[] = [];

    for (const [word, wp] of entries) {
      const info = lookup.get(word);
      const item: CollectionItem = {
        word,
        times_solved: wp.times_solved,
        times_hinted: wp.times_hinted,
        mastery_level: wp.mastery_level,
        due_for_review: wp.next_review_at <= now,
        kid_definition: info?.kid_definition ?? "",
        emoji: info?.emoji || "\u2728",
        grade_level: info?.grade_level ?? 1,
        example_sentence: info?.example_sentence ?? "",
        themes: info?.themes ?? []
      };
      collection.push(item);
      if (wp.times_hinted > 0 && wp.times_hinted >= wp.times_solved) hard.push(item);
      if (item.due_for_review) due.push(word);
    }

    return {
      ...p,
      collection,
      hard_words: hard.slice(0, 10),
      due_review_words: due,
      recent_attempts: this.state.attempts.slice(0, 30)
    };
  }

  private wordLookup(): Map<string, WordEntry> {
    const map = new Map<string, WordEntry>();
    for (const a of [...this.content.sample_assignments, ...this.state.assignments]) {
      for (const w of a.words) map.set(w.word, w);
    }
    for (const w of this.vocabulary()) map.set(w.word, w);
    return map;
  }

  async updateProfile(patch: { nickname?: string; dyslexia_font?: boolean; colorblind_mode?: boolean }): Promise<ProfileView> {
    const p = this.state.profile;
    if (patch.nickname !== undefined) p.nickname = cleanNickname(patch.nickname);
    if (patch.dyslexia_font !== undefined) p.dyslexia_font = patch.dyslexia_font;
    if (patch.colorblind_mode !== undefined) p.colorblind_mode = patch.colorblind_mode;
    await this.persist();
    return this.getProfile();
  }

  // ---------------------------------------------------------------- puzzles

  async generatePuzzle(req: PuzzleRequest = {}): Promise<GeneratedPuzzle> {
    const mode = req.mode ?? "adventure";
    const gradeBand = req.gradeBand ?? "G1_2";
    const difficulty = req.difficulty ?? "medium";
    const gen = this.getGenerator();

    if (mode === "classroom") {
      const assignment = await this.resolveAssignment(req.assignmentCode ?? "");
      const puzzle = gen.generate({
        gradeBand: assignment.grade_band,
        theme: "classroom",
        difficulty: assignment.difficulty,
        seed: assignment.seed,
        customWords: assignment.words
      });
      return {
        ...puzzle,
        assignment: { code: assignment.code, title: assignment.title, teacher_label: assignment.teacher_label }
      };
    }

    if (mode === "daily") {
      const seed = `daily-${localIsoDate(this.now())}-${gradeBand}`;
      return gen.generate({ gradeBand, theme: "daily", difficulty, seed });
    }

    const profile = this.getProfile();
    if (mode === "review") {
      if (profile.due_review_words.length >= 3) {
        const dueSet = new Set(profile.due_review_words);
        const lookup = this.wordLookup();
        const reviewPool = profile.due_review_words.map((w) => lookup.get(w)).filter((w): w is WordEntry => !!w);
        const bandMax = Math.max(...GRADE_BANDS[gradeBand].grades);
        const extra = this.vocabulary()
          .filter((w) => !dueSet.has(w.word) && w.grade_level <= bandMax)
          .slice(0, 25);
        const seed = req.seed ?? `review-${profile.profile_id}-${this.state.attempts.length}`;
        return gen.generate({ gradeBand, theme: "review", difficulty, seed, customWords: [...reviewPool, ...extra] });
      }
      const seed = req.seed ?? `mixed-${gradeBand}-${this.state.attempts.length}`;
      return {
        ...gen.generate({ gradeBand, theme: "all", difficulty, seed }),
        notice: "Solve a few more puzzles to unlock review words. Here is a mixed puzzle!"
      };
    }

    const theme = req.theme ?? "animals";
    const seed = req.seed ?? `adv-${theme}-${gradeBand}-${difficulty}-1`;
    const recentWords = profile.collection.slice(0, 12).map((c) => c.word);
    return gen.generate({ gradeBand, theme, difficulty, seed, recentWords });
  }

  async recordCompletion(payload: CompletionPayload): Promise<ProfileView & { stars_earned: number }> {
    const p = this.state.profile;
    const now = this.now();
    const solved = [...new Set(payload.solved_words.map((w) => w.toUpperCase()))];
    const hinted = new Set(payload.hinted_words.map((w) => w.toUpperCase()));
    const hintsUsed = Math.max(0, Math.floor(payload.hints_used) || 0);
    const starsSpent = Math.max(0, Math.floor(payload.stars_spent) || 0);

    const base = payload.difficulty === "easy" ? 6 : payload.difficulty === "medium" ? 9 : 12;
    const starsEarned = Math.max(2, base + (hintsUsed === 0 ? 3 : 0));

    p.stars = Math.max(0, p.stars + starsEarned - starsSpent);
    p.puzzles_completed += 1;
    if (payload.grade_band in GRADE_BANDS) p.grade_band = payload.grade_band as GradeBandCode;

    for (const w of solved) {
      const wasHinted = hinted.has(w);
      const existing = this.state.progress[w];
      if (!existing) {
        const mastery = wasHinted ? 1 : 2;
        this.state.progress[w] = {
          times_solved: 1,
          times_hinted: wasHinted ? 1 : 0,
          mastery_level: mastery,
          next_review_at: now + REVIEW_INTERVAL_HOURS[Math.min(mastery - 1, 4)] * HOUR_MS,
          last_seen_at: now
        };
      } else {
        const mastery = wasHinted ? Math.max(1, existing.mastery_level - 1) : Math.min(5, existing.mastery_level + 1);
        existing.times_solved += 1;
        existing.times_hinted += wasHinted ? 1 : 0;
        existing.mastery_level = mastery;
        existing.next_review_at = now + REVIEW_INTERVAL_HOURS[Math.min(mastery - 1, 4)] * HOUR_MS;
        existing.last_seen_at = now;
      }
    }

    this.state.attempts.unshift({
      attempt_id: randomId(12),
      puzzle_id: payload.puzzle_id,
      grade_band: payload.grade_band,
      theme: payload.theme,
      difficulty: payload.difficulty,
      words_count: solved.length,
      hints_used: hintsUsed,
      duration_sec: Math.max(0, Math.floor(payload.duration_sec) || 0),
      stars_earned: starsEarned,
      completed_at: now
    });
    this.state.attempts.length = Math.min(this.state.attempts.length, MAX_ATTEMPTS_KEPT);

    await this.persist();
    return { ...this.getProfile(), stars_earned: starsEarned };
  }

  // ---------------------------------------------------------------- classroom

  listAssignments(): AssignmentSummary[] {
    const local = [...this.state.assignments].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    const localCodes = new Set(local.map((a) => a.code));
    const all = [...local, ...this.content.sample_assignments.filter((a) => !localCodes.has(a.code))];
    return all.slice(0, 25).map((a) => ({
      code: a.code,
      title: a.title,
      teacher_label: a.teacher_label,
      grade_band: a.grade_band,
      difficulty: a.difficulty,
      word_count: a.words.length
    }));
  }

  getAssignment(code: string): AssignmentRecord | null {
    const key = code.trim().toUpperCase();
    return (
      this.state.assignments.find((a) => a.code === key) ??
      this.content.sample_assignments.find((a) => a.code === key) ??
      null
    );
  }

  private async resolveAssignment(codeOrShare: string): Promise<AssignmentRecord> {
    if (isShareCode(codeOrShare)) {
      const summary = await this.importShareCode(codeOrShare);
      return this.getAssignment(summary.code)!;
    }
    const found = this.getAssignment(codeOrShare);
    if (!found) throw new Error(`Classroom code '${codeOrShare.trim().toUpperCase()}' not found on this device.`);
    return found;
  }

  private buildAssignment(input: AssignmentInput, code: string): AssignmentRecord {
    if (!Array.isArray(input.words) || input.words.length < 3) {
      throw new Error("Please provide at least 3 words with clues for a classroom puzzle.");
    }
    if (input.words.length > MAX_ASSIGNMENT_WORDS) {
      throw new Error(`A classroom puzzle can have at most ${MAX_ASSIGNMENT_WORDS} words.`);
    }

    const words: WordEntry[] = [];
    for (const item of input.words) {
      const w = String(item.word ?? "").trim().toUpperCase();
      const clue = String(item.clue ?? "").trim().slice(0, MAX_CLUE_LENGTH);
      if (!w || !clue) continue;
      if (!isSafeWord(w) || w.length > 12) throw new Error(`Word '${w}' is not permitted by child safety rules.`);
      if (clueLeaksAnswer(w, clue)) throw new Error(`Clue for '${w}' cannot include the answer word itself.`);
      words.push({
        word: w,
        grade_level: 4,
        themes: ["classroom"],
        part_of_speech: "noun",
        kid_definition: clue,
        example_sentence: "Spell the word ___.",
        emoji: "\u{1F4DD}",
        synonyms: [],
        antonyms: [],
        safety_flag: false,
        review_status: "approved",
        version: 1
      });
    }
    if (words.length < 3) throw new Error("At least 3 valid word+clue pairs are required.");

    const band = (input.grade_band ?? "G3_4") in GRADE_BANDS ? (input.grade_band as GradeBandCode) : "G3_4";
    const diff: Difficulty = ["easy", "medium", "hard"].includes(input.difficulty ?? "")
      ? (input.difficulty as Difficulty)
      : "medium";

    return {
      code,
      title: (input.title ?? "").trim().slice(0, 60) || "Class Word Challenge",
      teacher_label: (input.teacher_label ?? "").trim().slice(0, 40) || "Teacher",
      grade_band: band,
      difficulty: diff,
      seed: `class-${code}`,
      words,
      created_at: this.now()
    };
  }

  private async saveAssignment(record: AssignmentRecord): Promise<AssignmentSummary & { share_code: string }> {
    this.state.assignments = [record, ...this.state.assignments.filter((a) => a.code !== record.code)];
    await this.persist();
    return {
      code: record.code,
      title: record.title,
      teacher_label: record.teacher_label,
      grade_band: record.grade_band,
      difficulty: record.difficulty,
      word_count: record.words.length,
      share_code: this.exportShareCode(record.code)
    };
  }

  async createAssignment(input: AssignmentInput): Promise<AssignmentSummary & { share_code: string }> {
    let code = randomId(6);
    while (this.getAssignment(code)) code = randomId(6);
    return this.saveAssignment(this.buildAssignment(input, code));
  }

  /** Import a teacher's share code (untrusted input: fully re-validated). */
  async importShareCode(text: string): Promise<AssignmentSummary & { share_code: string }> {
    const shared = decodeShareCode(text);
    const record = this.buildAssignment(
      {
        title: shared.title,
        teacher_label: shared.teacher_label,
        grade_band: shared.grade_band,
        difficulty: shared.difficulty,
        words: shared.words
      },
      shared.code
    );
    return this.saveAssignment(record);
  }

  exportShareCode(code: string): string {
    const a = this.getAssignment(code);
    if (!a) throw new Error(`Classroom code '${code}' not found.`);
    return encodeShareCode({
      code: a.code,
      title: a.title,
      teacher_label: a.teacher_label,
      grade_band: a.grade_band,
      difficulty: a.difficulty,
      words: a.words.map((w) => ({ word: w.word, clue: w.kid_definition }))
    });
  }

  // ---------------------------------------------------------------- educator studio

  async upsertWord(input: WordInput): Promise<UpsertWordResult> {
    const word = String(input.word ?? "").trim().toUpperCase();
    const definition = String(input.kid_definition ?? "").trim().slice(0, MAX_CLUE_LENGTH);
    const grade = Math.max(1, Math.min(6, Math.floor(Number(input.grade_level ?? 2)) || 2));

    if (!/^[A-Z]{2,12}$/.test(word)) throw new Error("Word must contain 2-12 letters A-Z.");
    if (!definition) throw new Error("Kid-friendly definition is required.");
    if (clueLeaksAnswer(word, definition)) throw new Error("Clue cannot contain the answer word or its direct root.");

    const safe = isSafeWord(word);
    const themes = splitList(input.themes, true);
    const existing = this.vocabulary().find((w) => w.word === word);
    const version = existing ? existing.version + 1 : 1;
    const reviewStatus = safe ? "approved" : "rejected";

    const entry: WordEntry = {
      word,
      grade_level: grade,
      themes: themes.length ? themes : ["animals"],
      part_of_speech: String(input.part_of_speech ?? "noun"),
      kid_definition: definition,
      example_sentence: String(input.example_sentence || "Can you spell ___?").slice(0, MAX_CLUE_LENGTH),
      emoji: Array.from(String(input.emoji || "\u2728")).slice(0, 4).join(""),
      synonyms: splitList(input.synonyms),
      antonyms: splitList(input.antonyms),
      safety_flag: !safe,
      review_status: reviewStatus,
      version
    };

    this.state.custom_words = [entry, ...this.state.custom_words.filter((w) => w.word !== word)];
    this.vocabCache = null;
    this.generator = null;
    await this.persist();

    return {
      word,
      version,
      safety_flag: !safe,
      review_status: reviewStatus,
      estimated_readability_grade: estimateGradeReadability(definition)
    };
  }
}
