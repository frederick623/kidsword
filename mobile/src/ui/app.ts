/**
 * UI controller for the offline mobile app; all data access goes through the
 * local GameService.
 *
 * Security: all dynamic text (teacher clues, share codes, nicknames, custom
 * words) is written via textContent / DOM APIs - never innerHTML.
 */
import type { Difficulty, Direction, GeneratedPuzzle, GradeBandCode, PlacedWord, PuzzleMode } from "../core/models";
import type { GameService, ProfileView, ThemeSummary } from "../services/gameService";
import { speak } from "../services/speech";

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string>; onClick?: () => void } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.onClick) node.addEventListener("click", props.onClick);
  for (const c of children) if (c) node.append(c);
  return node;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const BAND_LABEL: Record<GradeBandCode, string> = { G1_2: "Grades 1-2", G3_4: "Grades 3-4", G5_6: "Grades 5-6" };

export class App {
  private profile!: ProfileView;
  private themes: ThemeSummary[] = [];

  private gradeBand: GradeBandCode = "G1_2";
  private difficulty: Difficulty = "medium";
  private theme = "animals";
  private mode: PuzzleMode = "adventure";
  private assignmentCode = "";
  private puzzleCounter = 0;

  private puzzle: GeneratedPuzzle | null = null;
  private entries: string[][] = [];
  private locked: boolean[][] = [];
  private wrong = new Set<string>();
  private selRow = 0;
  private selCol = 0;
  private direction: Direction = "across";
  private hintsUsed = 0;
  private starsSpent = 0;
  private hintedWords = new Set<string>();
  private startedAt = Date.now();
  private completed = false;
  private gateAnswer = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly game: GameService) {}

  async start(): Promise<void> {
    await this.game.init();
    this.themes = this.game.getThemes();
    this.applyProfile(this.game.getProfile());
    this.gradeBand = this.profile.grade_band;
    el<HTMLSelectElement>("select-band").value = this.gradeBand;

    this.bindEvents();
    this.buildKeyboard();
    this.renderWorlds();
    this.renderAssignments();
    await this.startPuzzle({ mode: "adventure", theme: "animals" }, false);
  }

  // ------------------------------------------------------------------ general

  private toast(msg: string): void {
    const t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  private say(text: string): void {
    void speak(text, this.gradeBand === "G1_2");
  }

  private switchTab(tab: string): void {
    document.querySelectorAll<HTMLElement>(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll<HTMLElement>(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
    if (tab === "collection") this.renderCollection();
    if (tab === "grownups") this.resetGate();
    window.scrollTo(0, 0);
  }

  private applyProfile(profile: ProfileView): void {
    this.profile = profile;
    el("hero-nickname").textContent = profile.nickname;
    el<HTMLInputElement>("input-nickname").value = profile.nickname;
    el("star-count").textContent = String(profile.stars);
    el("parent-stat-puzzles").textContent = String(profile.puzzles_completed);
    el("parent-stat-words").textContent = String(profile.collection.length);
    el("parent-stat-stars").textContent = String(profile.stars);

    document.body.classList.toggle("dyslexia-font", profile.dyslexia_font);
    document.body.classList.toggle("colorblind-mode", profile.colorblind_mode);
    el("btn-dyslexia").classList.toggle("active", profile.dyslexia_font);
    el("btn-contrast").classList.toggle("active", profile.colorblind_mode);

    const hard = el("parent-hard-words");
    if (profile.hard_words.length) {
      hard.replaceChildren(
        ...profile.hard_words.map((w) => h("span", { className: "badge", text: `${w.emoji} ${w.word} (hints: ${w.times_hinted})` }))
      );
    } else {
      hard.textContent = "Solve a few puzzles to see practice insights!";
    }
  }

  // ------------------------------------------------------------------ hub

  private renderWorlds(): void {
    const cards = this.themes.map((t) => {
      const launch = () => void this.startPuzzle({ mode: "adventure", theme: t.id }, true);
      const card = h(
        "div",
        { className: "world-card", attrs: { role: "button", tabindex: "0", "aria-label": `Play ${t.name}` }, onClick: launch },
        h("div", { className: "world-emoji", text: t.emoji, attrs: { "aria-hidden": "true" } }),
        h("div", { className: "world-title", text: t.name }),
        h("div", { className: "world-mascot", text: `Guide: ${t.mascot}` }),
        h("div", { className: "world-desc", text: t.description }),
        h(
          "div",
          { className: "world-meta" },
          h("span", { text: `\u{1F4DA} ${t.word_count} Words` }),
          h("span", { text: "Play \u27A1\uFE0F" })
        )
      );
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          launch();
        }
      });
      return card;
    });
    el("worlds-grid").replaceChildren(...cards);
  }

  private renderAssignments(): void {
    const list = this.game.listAssignments();
    el("available-codes-list").replaceChildren(
      ...list.map((a) =>
        h(
          "div",
          { className: "assignment-row" },
          h(
            "div",
            {},
            h("strong", { text: a.code }),
            ` - ${a.title}`,
            h("div", { className: "assignment-meta", text: `${a.teacher_label} | ${BAND_LABEL[a.grade_band]} | ${a.word_count} words` })
          ),
          h("button", {
            className: "action-btn secondary small",
            text: "Play",
            onClick: () => {
              el<HTMLTextAreaElement>("input-class-code").value = a.code;
              void this.startPuzzle({ mode: "classroom", assignmentCode: a.code }, true);
            }
          })
        )
      )
    );
  }

  // ------------------------------------------------------------------ puzzle

  private async startPuzzle(
    opts: { mode?: PuzzleMode; theme?: string; assignmentCode?: string },
    goToPlay: boolean
  ): Promise<void> {
    this.gradeBand = el<HTMLSelectElement>("select-band").value as GradeBandCode;
    this.difficulty = el<HTMLSelectElement>("select-difficulty").value as Difficulty;
    const mode = opts.mode ?? "adventure";
    const theme = opts.theme ?? this.theme;
    this.puzzleCounter += 1;

    try {
      const puzzle = await this.game.generatePuzzle({
        mode,
        theme,
        gradeBand: this.gradeBand,
        difficulty: this.difficulty,
        seed: `${mode}-${theme}-${this.gradeBand}-${this.difficulty}-${Date.now()}-${this.puzzleCounter}`,
        assignmentCode: opts.assignmentCode
      });
      this.mode = mode;
      this.theme = theme;
      if (mode === "classroom" && puzzle.assignment) {
        this.assignmentCode = puzzle.assignment.code;
        this.renderAssignments();
      }
      this.loadPuzzle(puzzle);
      if (puzzle.notice) this.toast(puzzle.notice);
      if (goToPlay) this.switchTab("play");
    } catch (err) {
      this.toast(err instanceof Error ? err.message : "Could not create a puzzle.");
    }
  }

  private loadPuzzle(p: GeneratedPuzzle): void {
    this.puzzle = p;
    this.hintsUsed = 0;
    this.starsSpent = 0;
    this.hintedWords = new Set();
    this.wrong = new Set();
    this.startedAt = Date.now();
    this.completed = false;
    this.entries = p.prefilled.map((row) => row.map((v) => v ?? ""));
    this.locked = p.prefilled.map((row) => row.map((v) => Boolean(v)));

    const title = p.assignment
      ? `\u{1F3EB} ${p.assignment.title}`
      : `\u2728 ${p.theme.charAt(0).toUpperCase()}${p.theme.slice(1)}`;
    el("play-badge-theme").textContent = title;
    el("play-badge-band").textContent = BAND_LABEL[p.grade_band];
    el("play-badge-diff").textContent = p.difficulty.toUpperCase();

    const first = p.words[0];
    if (first) {
      this.selRow = first.row;
      this.selCol = first.col;
      this.direction = first.direction;
    }
    this.refresh();
  }

  private cells(w: PlacedWord): [number, number][] {
    const dr = w.direction === "across" ? 0 : 1;
    const dc = w.direction === "across" ? 1 : 0;
    return Array.from({ length: w.word.length }, (_, i) => [w.row + dr * i, w.col + dc * i]);
  }

  private activeWord(): PlacedWord | null {
    if (!this.puzzle) return null;
    const find = (dir: Direction) =>
      this.puzzle!.words.find((w) => w.direction === dir && this.cells(w).some(([r, c]) => r === this.selRow && c === this.selCol));
    return find(this.direction) ?? find(this.direction === "across" ? "down" : "across") ?? this.puzzle.words[0] ?? null;
  }

  private isSolved(w: PlacedWord): boolean {
    return this.cells(w).every(([r, c], i) => this.entries[r][c] === w.word[i]);
  }

  private refresh(): void {
    this.renderBoard();
    this.renderClues();
    this.renderBanner();
  }

  private renderBoard(): void {
    const p = this.puzzle;
    if (!p) return;
    const gridEl = el("crossword-grid");
    const avail = Math.min(window.innerWidth - 48, 560);
    const cellPx = Math.max(26, Math.min(52, Math.floor(avail / p.cols) - 2));
    gridEl.style.setProperty("--cell", `${cellPx}px`);
    gridEl.style.gridTemplateColumns = `repeat(${p.cols}, ${cellPx}px)`;

    const aw = this.activeWord();
    const activeSet = new Set((aw ? this.cells(aw) : []).map(([r, c]) => `${r},${c}`));
    const solved = new Set<string>();
    for (const w of p.words) if (this.isSolved(w)) this.cells(w).forEach(([r, c]) => solved.add(`${r},${c}`));

    const nodes: HTMLElement[] = [];
    for (let r = 0; r < p.rows; r++) {
      for (let c = 0; c < p.cols; c++) {
        if (p.grid[r][c] === null) {
          nodes.push(h("div", { className: "cw-cell block", attrs: { "aria-hidden": "true" } }));
          continue;
        }
        const key = `${r},${c}`;
        const cls = ["cw-cell"];
        if (activeSet.has(key)) cls.push("in-word");
        if (r === this.selRow && c === this.selCol) cls.push("selected");
        if (this.locked[r][c]) cls.push("prefilled");
        if (solved.has(key)) cls.push("correct");
        if (this.wrong.has(key)) cls.push("wrong");

        const num = p.numbers[r][c];
        const val = this.entries[r][c];
        const cell = h(
          "button",
          {
            className: cls.join(" "),
            attrs: { role: "gridcell", type: "button", "aria-label": `Row ${r + 1} column ${c + 1}${val ? `, ${val}` : ", empty"}` },
            onClick: () => this.selectCell(r, c)
          },
          num ? h("span", { className: "cell-num", text: String(num) }) : null,
          h("span", { text: val })
        );
        nodes.push(cell);
      }
    }
    gridEl.replaceChildren(...nodes);
  }

  private selectCell(r: number, c: number): void {
    if (this.selRow === r && this.selCol === c) {
      this.direction = this.direction === "across" ? "down" : "across";
    } else {
      this.selRow = r;
      this.selCol = c;
    }
    const aw = this.activeWord();
    if (aw) this.direction = aw.direction;
    this.refresh();
  }

  private renderClues(): void {
    const p = this.puzzle;
    if (!p) return;
    const aw = this.activeWord();
    const across: HTMLElement[] = [];
    const down: HTMLElement[] = [];
    for (const w of p.words) {
      const active = aw?.number === w.number && aw.direction === w.direction;
      const item = h(
        "button",
        {
          className: `clue-item${active ? " active" : ""}${this.isSolved(w) ? " solved" : ""}`,
          attrs: { type: "button" },
          onClick: () => {
            this.selRow = w.row;
            this.selCol = w.col;
            this.direction = w.direction;
            this.refresh();
            if (this.gradeBand === "G1_2") this.say(w.clue);
          }
        },
        h("span", { className: "clue-num-badge", text: `${w.number}.` }),
        h("span", { text: `${w.clue} (${w.word.length})` })
      );
      (w.direction === "across" ? across : down).push(item);
    }
    el("clues-across").replaceChildren(...across);
    el("clues-down").replaceChildren(...down);
  }

  private renderBanner(): void {
    const aw = this.activeWord();
    if (!aw) return;
    el("active-clue-emoji").textContent = aw.emoji || "\u2728";
    el("active-clue-dir").textContent = `${aw.number} ${aw.direction.toUpperCase()} - ${aw.word.length} LETTERS`;
    el("active-clue-text").textContent = aw.clue;
    el("active-clue-sentence").textContent = aw.example_sentence ? `Sentence: "${aw.example_sentence}"` : "";
  }

  // ------------------------------------------------------------------ input

  private typeLetter(letter: string): void {
    const p = this.puzzle;
    if (!p || this.completed) return;
    const r = this.selRow;
    const c = this.selCol;
    if (p.grid[r]?.[c] == null) return;

    if (!this.locked[r][c]) {
      this.entries[r][c] = letter;
      this.wrong.delete(`${r},${c}`);
    }
    const aw = this.activeWord();
    if (aw) {
      const cells = this.cells(aw);
      const idx = cells.findIndex(([cr, cc]) => cr === r && cc === c);
      const nextEmpty = cells.slice(idx + 1).find(([nr, nc]) => !this.entries[nr][nc]);
      const next = nextEmpty ?? cells[idx + 1];
      if (next) [this.selRow, this.selCol] = next;
    }
    this.refresh();
    void this.checkCompletion();
  }

  private backspace(): void {
    if (!this.puzzle || this.completed) return;
    const r = this.selRow;
    const c = this.selCol;
    if (!this.locked[r]?.[c] && this.entries[r]?.[c]) {
      this.entries[r][c] = "";
      this.wrong.delete(`${r},${c}`);
      this.refresh();
      return;
    }
    const aw = this.activeWord();
    if (!aw) return;
    const cells = this.cells(aw);
    const idx = cells.findIndex(([cr, cc]) => cr === r && cc === c);
    if (idx > 0) {
      const [pr, pc] = cells[idx - 1];
      this.selRow = pr;
      this.selCol = pc;
      if (!this.locked[pr][pc]) {
        this.entries[pr][pc] = "";
        this.wrong.delete(`${pr},${pc}`);
      }
      this.refresh();
    }
  }

  private moveSelection(dr: number, dc: number): void {
    const nr = this.selRow + dr;
    const nc = this.selCol + dc;
    const target = this.puzzle?.grid[nr]?.[nc];
    if (target !== undefined && target !== null) {
      this.selRow = nr;
      this.selCol = nc;
      this.refresh();
    }
  }

  private buildKeyboard(): void {
    const rows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
    const rowEls = rows.map((letters, i) => {
      const keys = [...letters].map((k) =>
        h("button", { className: "kb-key", text: k, attrs: { type: "button", "aria-label": `Letter ${k}` }, onClick: () => this.typeLetter(k) })
      );
      if (i === rows.length - 1) {
        keys.push(
          h("button", { className: "kb-key wide", text: "\u232B Back", attrs: { type: "button", "aria-label": "Backspace" }, onClick: () => this.backspace() })
        );
      }
      return h("div", { className: "kb-row" }, ...keys);
    });
    el("kid-keyboard").replaceChildren(...rowEls);
  }

  // ------------------------------------------------------------------ hints

  private spendStars(cost: number): boolean {
    if (this.profile.stars - this.starsSpent < cost) {
      this.toast(`Need ${cost} \u2B50 for this hint! Keep solving to earn more stars.`);
      return false;
    }
    this.starsSpent += cost;
    el("star-count").textContent = String(this.profile.stars - this.starsSpent);
    return true;
  }

  private hintLetter(): void {
    const aw = this.activeWord();
    if (!aw || this.completed) return;
    const cells = this.cells(aw);
    let idx = cells.findIndex(([r, c]) => r === this.selRow && c === this.selCol);
    if (idx === -1 || this.entries[cells[idx][0]][cells[idx][1]] === aw.word[idx]) {
      idx = cells.findIndex(([r, c], i) => this.entries[r][c] !== aw.word[i]);
      if (idx === -1) {
        this.toast("This word is already complete! \u{1F31F}");
        return;
      }
    }
    if (!this.spendStars(2)) return;
    const [r, c] = cells[idx];
    this.entries[r][c] = aw.word[idx];
    this.locked[r][c] = true;
    this.wrong.delete(`${r},${c}`);
    this.hintsUsed += 1;
    this.hintedWords.add(aw.word);
    this.refresh();
    void this.checkCompletion();
  }

  private hintCheck(): void {
    const aw = this.activeWord();
    if (!aw || this.completed) return;
    if (!this.spendStars(1)) return;
    let mistakes = 0;
    this.cells(aw).forEach(([r, c], i) => {
      const v = this.entries[r][c];
      if (v && v !== aw.word[i]) {
        this.wrong.add(`${r},${c}`);
        mistakes++;
      } else if (v === aw.word[i]) {
        this.locked[r][c] = true;
      }
    });
    this.hintsUsed += 1;
    this.renderBoard();
    this.toast(mistakes === 0 ? "Looking great! No wrong letters in this word! \u2705" : `Found ${mistakes} letter(s) to fix!`);
  }

  private hintWord(): void {
    const aw = this.activeWord();
    if (!aw || this.completed) return;
    if (this.isSolved(aw)) {
      this.toast("You already solved this word!");
      return;
    }
    if (!this.spendStars(5)) return;
    this.cells(aw).forEach(([r, c], i) => {
      this.entries[r][c] = aw.word[i];
      this.locked[r][c] = true;
      this.wrong.delete(`${r},${c}`);
    });
    this.hintsUsed += 1;
    this.hintedWords.add(aw.word);
    this.refresh();
    void this.checkCompletion();
  }

  // ------------------------------------------------------------------ completion

  private async checkCompletion(): Promise<void> {
    const p = this.puzzle;
    if (!p || this.completed || !p.words.every((w) => this.isSolved(w))) return;
    this.completed = true;

    const durationSec = Math.max(5, Math.round((Date.now() - this.startedAt) / 1000));
    const words = [...new Set(p.words.map((w) => w.word))];
    const result = await this.game.recordCompletion({
      puzzle_id: p.puzzle_id,
      grade_band: p.grade_band,
      theme: p.theme,
      difficulty: p.difficulty,
      solved_words: words,
      hinted_words: [...this.hintedWords],
      hints_used: this.hintsUsed,
      stars_spent: this.starsSpent,
      duration_sec: durationSec
    });
    this.starsSpent = 0;
    this.applyProfile(result);

    el("win-stars-pill").textContent = `+${result.stars_earned} \u2B50 Earned!`;
    el("win-summary").textContent = `Solved ${words.length} words in ${durationSec}s! Tap any word to hear it:`;
    el("win-words-list").replaceChildren(
      ...p.words.map((w) =>
        h("button", { className: "learned-chip", text: `${w.emoji} ${w.word} \u{1F50A}`, onClick: () => this.say(`${w.word}. ${w.clue}`) })
      )
    );
    el("win-modal").classList.add("open");
  }

  // ------------------------------------------------------------------ word book

  private renderCollection(): void {
    const items = this.profile.collection;
    el("collection-stats-badge").textContent = `${items.length} Words Collected`;
    const grid = el("collection-grid");
    if (!items.length) {
      grid.replaceChildren(
        h(
          "div",
          { className: "panel-card empty" },
          h("div", { className: "big-emoji", text: "\u{1F4D8}" }),
          h("h3", { text: "Your Word Book is waiting!" }),
          h("p", { className: "muted", text: "Complete any crossword puzzle to unlock collectible word cards here." })
        )
      );
      return;
    }
    grid.replaceChildren(
      ...items.map((item) =>
        h(
          "div",
          { className: "word-card" },
          h(
            "div",
            { className: "word-card-head" },
            h(
              "div",
              {},
              h("span", { className: "word-card-emoji", text: item.emoji || "\u2B50" }),
              h("span", { className: "word-card-title", text: item.word })
            ),
            h("button", {
              className: "speak-btn small",
              text: "\u{1F50A}",
              attrs: { "aria-label": `Pronounce ${item.word}` },
              onClick: () => this.say(`${item.word}. ${item.kid_definition}`)
            })
          ),
          h("div", {
            className: "mastery-dots",
            text: "\u2605".repeat(item.mastery_level) + "\u2606".repeat(Math.max(0, 5 - item.mastery_level)),
            attrs: { "aria-label": `Mastery ${item.mastery_level} of 5` }
          }),
          h("div", { className: "word-card-def", text: item.kid_definition }),
          h("div", { className: "word-card-meta", text: `Solved ${item.times_solved}x${item.due_for_review ? " | Ready to review" : ""}` })
        )
      )
    );
  }

  // ------------------------------------------------------------------ grown-ups

  private resetGate(): void {
    const buf = new Uint8Array(2);
    crypto.getRandomValues(buf);
    const a = 6 + (buf[0] % 7);
    const b = 6 + (buf[1] % 7);
    this.gateAnswer = a * b;
    el("gate-question").textContent = `Adult Check: What is ${a} x ${b}?`;
    el<HTMLInputElement>("gate-answer").value = "";
    el("gate-error").textContent = "";
    el("parental-gate-card").hidden = false;
    el("grownups-dashboard").hidden = true;
  }

  private async createAssignment(): Promise<void> {
    const out = el("teacher-result");
    const words = el<HTMLTextAreaElement>("teacher-words")
      .value.split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(":");
        return i === -1 ? null : { word: line.slice(0, i).trim(), clue: line.slice(i + 1).trim() };
      })
      .filter((w): w is { word: string; clue: string } => w !== null);

    try {
      const created = await this.game.createAssignment({
        title: el<HTMLInputElement>("teacher-title").value,
        teacher_label: el<HTMLInputElement>("teacher-name").value,
        grade_band: el<HTMLSelectElement>("teacher-band").value,
        difficulty: "medium",
        words
      });
      const shareArea = h("textarea", { attrs: { rows: "3", readonly: "", "aria-label": "Share code" } });
      shareArea.value = created.share_code;
      out.replaceChildren(
        h(
          "div",
          { className: "share-box" },
          h("div", {}, "\u2705 Class code ", h("strong", { text: created.code }), ` created (${created.word_count} words).`),
          h("div", { className: "muted small-text", text: "Send this share code to students; they paste it in Class Code. No internet needed." }),
          shareArea,
          h("button", {
            className: "action-btn secondary small",
            text: "\u{1F4CB} Copy share code",
            onClick: () => void this.copyText(created.share_code, shareArea)
          })
        )
      );
      this.renderAssignments();
    } catch (err) {
      out.replaceChildren(h("span", { className: "error-text", text: `\u26A0\uFE0F ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  private async copyText(text: string, fallback: HTMLTextAreaElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast("Share code copied!");
    } catch {
      fallback.select();
      this.toast("Select and copy the code above.");
    }
  }

  private async saveWord(): Promise<void> {
    const msg = el("admin-save-msg");
    try {
      const saved = await this.game.upsertWord({
        word: el<HTMLInputElement>("admin-word").value,
        grade_level: Number(el<HTMLSelectElement>("admin-grade").value),
        themes: el<HTMLInputElement>("admin-themes").value,
        emoji: el<HTMLInputElement>("admin-emoji").value,
        kid_definition: el<HTMLInputElement>("admin-def").value,
        example_sentence: el<HTMLInputElement>("admin-sentence").value || "Can you spell ___?"
      });
      msg.className = `status-msg ${saved.safety_flag ? "err" : "ok"}`;
      msg.textContent = `Saved ${saved.word} (v${saved.version}, status: ${saved.review_status}, readability grade ~${saved.estimated_readability_grade})`;
      el<HTMLInputElement>("admin-word").value = "";
      el<HTMLInputElement>("admin-def").value = "";
      this.themes = this.game.getThemes();
      this.renderWorlds();
    } catch (err) {
      msg.className = "status-msg err";
      msg.textContent = `\u26A0\uFE0F ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ------------------------------------------------------------------ events

  private bindEvents(): void {
    document.querySelectorAll<HTMLElement>(".nav-btn").forEach((b) => b.addEventListener("click", () => this.switchTab(b.dataset.tab ?? "worlds")));

    el("btn-dyslexia").addEventListener("click", async () => {
      const on = !this.profile.dyslexia_font;
      this.applyProfile(await this.game.updateProfile({ dyslexia_font: on }));
      this.toast(on ? "Dyslexia-friendly spacing enabled" : "Standard font enabled");
    });
    el("btn-contrast").addEventListener("click", async () => {
      const on = !this.profile.colorblind_mode;
      this.applyProfile(await this.game.updateProfile({ colorblind_mode: on }));
      this.toast(on ? "Color-blind safe mode enabled" : "Standard palette enabled");
    });

    el("btn-daily").addEventListener("click", () => void this.startPuzzle({ mode: "daily", theme: "daily" }, true));
    el("btn-review").addEventListener("click", () => void this.startPuzzle({ mode: "review", theme: "review" }, true));
    el("btn-new-puzzle").addEventListener("click", () => void this.nextPuzzle());

    el("btn-speak-clue").addEventListener("click", () => {
      const aw = this.activeWord();
      if (aw) this.say(`${aw.number} ${aw.direction}. ${aw.clue}`);
    });
    el("hint-letter").addEventListener("click", () => this.hintLetter());
    el("hint-check").addEventListener("click", () => this.hintCheck());
    el("hint-word").addEventListener("click", () => this.hintWord());
    el("btn-toggle-dir").addEventListener("click", () => {
      this.direction = this.direction === "across" ? "down" : "across";
      this.refresh();
    });

    el("btn-win-next").addEventListener("click", () => {
      el("win-modal").classList.remove("open");
      void this.nextPuzzle();
    });
    el("btn-win-worlds").addEventListener("click", () => {
      el("win-modal").classList.remove("open");
      this.switchTab("worlds");
    });

    el("btn-join-class").addEventListener("click", () => {
      const code = el<HTMLTextAreaElement>("input-class-code").value.trim();
      if (!code) {
        this.toast("Enter a classroom code first!");
        return;
      }
      void this.startPuzzle({ mode: "classroom", assignmentCode: code }, true);
    });

    const unlock = () => {
      if (Number.parseInt(el<HTMLInputElement>("gate-answer").value, 10) === this.gateAnswer) {
        el("parental-gate-card").hidden = true;
        el("grownups-dashboard").hidden = false;
      } else {
        el("gate-error").textContent = "Not quite - please try again!";
      }
    };
    el("btn-unlock-gate").addEventListener("click", unlock);
    el("gate-answer").addEventListener("keydown", (e) => {
      if (e.key === "Enter") unlock();
    });

    el("btn-save-nickname").addEventListener("click", async () => {
      const p = await this.game.updateProfile({ nickname: el<HTMLInputElement>("input-nickname").value });
      this.applyProfile(p);
      this.toast(`Saved explorer nickname: ${p.nickname}`);
    });
    el("btn-create-assignment").addEventListener("click", () => void this.createAssignment());
    el("btn-admin-save-word").addEventListener("click", () => void this.saveWord());

    window.addEventListener("resize", () => this.renderBoard());
    window.addEventListener("keydown", (e) => {
      if (!el("view-play").classList.contains("active") || el("win-modal").classList.contains("open")) return;
      const tag = document.activeElement?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        this.typeLetter(e.key.toUpperCase());
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        this.backspace();
      } else if (e.key === "Tab" || e.key === " ") {
        e.preventDefault();
        this.direction = this.direction === "across" ? "down" : "across";
        this.refresh();
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        this.moveSelection(e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0, e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0);
      }
    });
  }

  private nextPuzzle(): Promise<void> {
    return this.startPuzzle(
      { mode: this.mode, theme: this.theme, assignmentCode: this.mode === "classroom" ? this.assignmentCode : undefined },
      true
    );
  }
}
