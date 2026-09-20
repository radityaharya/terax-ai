export type AnsiSpan = { text: string; className: string | null };

const FG: Record<number, string> = {
  30: "text-neutral-900 dark:text-neutral-100",
  31: "text-red-600 dark:text-red-400",
  32: "text-green-600 dark:text-green-400",
  33: "text-amber-600 dark:text-amber-400",
  34: "text-blue-600 dark:text-blue-400",
  35: "text-fuchsia-600 dark:text-fuchsia-400",
  36: "text-cyan-600 dark:text-cyan-400",
  37: "text-neutral-600 dark:text-neutral-300",
  90: "text-neutral-500 dark:text-neutral-400",
  91: "text-red-500",
  92: "text-green-500",
  93: "text-amber-500",
  94: "text-blue-500",
  95: "text-fuchsia-500",
  96: "text-cyan-500",
  97: "text-neutral-400 dark:text-neutral-200",
};

const BG: Record<number, string> = {
  40: "bg-neutral-900/10",
  41: "bg-red-500/15",
  42: "bg-green-500/15",
  43: "bg-amber-500/15",
  44: "bg-blue-500/15",
  45: "bg-fuchsia-500/15",
  46: "bg-cyan-500/15",
  47: "bg-neutral-500/15",
};

type Pen = { fg: string | null; bg: string | null; bold: boolean; dim: boolean; italic: boolean; underline: boolean };

const RESET: Pen = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };

function penClass(pen: Pen): string | null {
  const parts: string[] = [];
  if (pen.fg) parts.push(pen.fg);
  if (pen.bg) parts.push(pen.bg);
  if (pen.bold) parts.push("font-semibold");
  if (pen.dim) parts.push("opacity-70");
  if (pen.italic) parts.push("italic");
  if (pen.underline) parts.push("underline");
  return parts.length > 0 ? parts.join(" ") : null;
}

function applyCodes(pen: Pen, codes: number[]): Pen {
  if (codes.length === 0) return { ...RESET };
  let next = { ...pen };
  for (const code of codes) {
    if (code === 0) next = { ...RESET };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if (FG[code]) next.fg = FG[code];
    else if (BG[code]) next.bg = BG[code];
    // 256/truecolor (38;5;n / 38;2;r;g;b) ignored — default color.
  }
  return next;
}

/** Split one log line on SGR sequences into styled spans. */
export function ansiSpans(line: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let pen: Pen = { ...RESET };
  // eslint-disable-next-line no-control-regex
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let guard = 0;
  for (;;) {
    guard++;
    if (guard > line.length + 10) break;
    const m: RegExpExecArray | null = re.exec(line);
    if (m === null) break;
    if (m.index > last) {
      out.push({ text: line.slice(last, m.index), className: penClass(pen) });
    }
    const codes = m[1] === "" ? [0] : m[1].split(";").map((n) => Number(n) || 0);
    pen = applyCodes(pen, codes);
    last = m.index + m[0].length;
  }
  if (last < line.length) {
    out.push({ text: line.slice(last), className: penClass(pen) });
  }
  return out;
}

/** Strip ANSI for filtering/export. */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*m/g, "");
}
