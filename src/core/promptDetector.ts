import logger from "../utils/logger.js";

export interface DetectedPrompt {
  /** The full line or chunk that triggered the detection */
  raw: string;
  /** Normalized prompt type */
  type: "confirmation" | "yes_no" | "choice" | "input" | "permission";
  /** Short human-readable summary */
  summary: string;
}

/**
 * Ordered list of patterns.
 * First match wins. Patterns are tested against ANSI-stripped text.
 */
const PATTERNS: Array<{
  regex: RegExp;
  type: DetectedPrompt["type"];
  summary: (match: RegExpMatchArray) => string;
}> = [
  // Claude Code trust prompt
  {
    regex:
      /(?:Yes,\s*I\s*trust|trust\s*this\s*folder|Is\s*this\s*a\s*project\s*you\s*(?:created|trust))/i,
    type: "confirmation",
    summary: () => "Claude is asking if you trust this workspace folder.",
  },
  // Claude Code permission-style prompts
  {
    regex:
      /(?:do you want to (?:proceed|continue)|proceed with (?:these )?changes\??|allow this action\??)/i,
    type: "permission",
    summary: () => "Claude is asking for permission to proceed.",
  },
  {
    regex:
      /(?:wants? to (?:edit|modify|create|delete|write|read|execute|run|remove))/i,
    type: "permission",
    summary: (m) => m[0].charAt(0).toUpperCase() + m[0].slice(1) + ".",
  },
  // Generic yes/no
  {
    regex: /\[y\/n\]/i,
    type: "yes_no",
    summary: () => "Yes/No prompt detected.",
  },
  {
    regex: /\(y(?:es)?\/n(?:o)?\)/i,
    type: "yes_no",
    summary: () => "Yes/No prompt detected.",
  },
  // "Do you want to continue?"
  {
    regex: /(do you want to .+\?)/i,
    type: "confirmation",
    summary: (m) => m[1],
  },
  // Tool-use permission pattern from Claude Code
  {
    regex: /(?:allow|deny|approve|reject)\s+(?:tool|action|command)/i,
    type: "permission",
    summary: () => "Tool/action approval requested.",
  },
  // Enter to confirm
  {
    regex: /Enter\s*to\s*confirm|Esc\s*to\s*cancel/i,
    type: "input",
    summary: () => "Press Enter to confirm.",
  },
  // Press Enter / continue prompt
  {
    regex:
      /(?:press enter|hit enter|press return|continue\.\.\.|press any key)/i,
    type: "input",
    summary: () => "Press Enter to continue.",
  },
  // Generic choice brackets [1/2/3]
  {
    regex: /\[\d+(?:\/\d+)+\]/,
    type: "choice",
    summary: () => "Multiple choice prompt detected.",
  },
];

// ANSI escape code stripper — covers CSI, OSC hyperlinks, private mode sequences, etc.
// Using a regex literal to avoid double-escaping hell
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-9;?]*[A-Za-z]|\x1B\]\d*;[^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\][^\x07]*\x07|\x1B[()][AB012]|\x1B[>=]|\x1B\[\?[0-9;]*[hlsr]|\x1B[78]|\x1B\[[0-9]*[ABCDEFGJKST]/g;

/**
 * Strips ANSI escape codes from raw PTY output.
 * Replaces escape sequences with a space (to preserve word boundaries)
 * then normalizes whitespace.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_RE, " ") // replace escapes with space to keep word boundaries
    .replace(/\]8;;[^\x07]*\x07/g, " ") // leftover OSC 8 hyperlinks
    .replace(/\]8;;[^\\]*\\\\/g, " ") // OSC 8 with ST terminator
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // remaining control chars (no space needed)
    .replace(/[ \t]+/g, " ") // collapse horizontal whitespace
    .replace(/^\s+$/gm, "") // remove whitespace-only lines
    .replace(/\n{3,}/g, "\n\n") // max 2 consecutive newlines
    .trim();
}

/**
 * Checks a chunk of output for known interactive prompts.
 * Returns the first matched prompt or null.
 */
export function detectPrompt(rawChunk: string): DetectedPrompt | null {
  const clean = stripAnsi(rawChunk);

  for (const pattern of PATTERNS) {
    const match = clean.match(pattern.regex);
    if (match) {
      const prompt: DetectedPrompt = {
        raw: clean.trim().slice(-300), // last 300 chars for context
        type: match ? pattern.type : "input",
        summary: pattern.summary(match),
      };
      logger.debug(
        { type: prompt.type, summary: prompt.summary },
        "Prompt detected",
      );
      return prompt;
    }
  }

  return null;
}

/**
 * Register additional custom patterns at runtime.
 */
export function addPattern(
  regex: RegExp,
  type: DetectedPrompt["type"],
  summary: (match: RegExpMatchArray) => string,
): void {
  PATTERNS.push({ regex, type, summary });
}
