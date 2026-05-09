export interface LintViolation {
  line: number;
  col: number;
  word: string;
  suggestion?: string;
}

/** Check Markdown text against the banned-words list. */
export function checkBannedWords(markdown: string, bannedWords: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  const lines = markdown.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const word of bannedWords) {
      const idx = line.indexOf(word);
      if (idx !== -1) {
        violations.push({ line: i + 1, col: idx + 1, word });
      }
    }
  }
  return violations;
}
