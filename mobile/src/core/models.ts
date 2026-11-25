export type Direction = "across" | "down";
export type Difficulty = "easy" | "medium" | "hard";
export type GradeBandCode = "G1_2" | "G3_4" | "G5_6";
export type PuzzleMode = "adventure" | "daily" | "review" | "classroom";

export interface GradeBandSpec {
  code: GradeBandCode;
  label: string;
  grades: number[];
  min_grid: number;
  max_grid: number;
  min_word_len: number;
  max_word_len: number;
  min_words: number;
  max_words: number;
  clue_style: string;
}

export interface WordEntry {
  word: string;
  grade_level: number;
  themes: string[];
  part_of_speech: string;
  kid_definition: string;
  example_sentence: string;
  emoji: string;
  picture_url?: string;
  audio_url?: string;
  synonyms: string[];
  antonyms: string[];
  frequency_score?: number;
  difficulty_score?: number;
  safety_flag: boolean;
  review_status: string;
  version: number;
}

export interface ThemeMeta {
  id: string;
  name: string;
  emoji: string;
  mascot: string;
  color: string;
  description: string;
}

export interface PlacedWord {
  number: number;
  direction: Direction;
  row: number;
  col: number;
  word: string;
  clue: string;
  example_sentence: string;
  emoji: string;
  grade_level: number;
  themes: string[];
  part_of_speech: string;
  synonyms: string[];
  antonyms: string[];
  revealed_indices: number[];
}

export type Grid = (string | null)[][];

export interface GeneratedPuzzle {
  puzzle_id: string;
  seed: string;
  grade_band: GradeBandCode;
  theme: string;
  difficulty: Difficulty;
  rows: number;
  cols: number;
  grid: Grid;
  numbers: (number | null)[][];
  prefilled: Grid;
  words: PlacedWord[];
  quality_score: number;
  generation_ms: number;
  assignment?: { code: string; title: string; teacher_label: string };
  notice?: string;
}

export interface AssignmentRecord {
  code: string;
  title: string;
  teacher_label: string;
  grade_band: GradeBandCode;
  difficulty: Difficulty;
  seed: string;
  words: WordEntry[];
  created_at?: number;
}
