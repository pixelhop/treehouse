// Laying out minified JSON for reading in the code viewer.
//
// This re-indents the text token by token rather than round-tripping it through
// JSON.parse/JSON.stringify. A round trip rewrites values: an id like
// 12345678901234567890 comes back as 12345678901234567000, and `1.0` comes back
// as `1`. A viewer must show what the file says, so only whitespace changes.

/**
 * The JSON laid out with two-space indentation, or null when it should be shown
 * as written: it isn't valid JSON, or it already spans several lines (someone
 * chose that layout, so it stays).
 */
export function formatMinifiedJson(source: string): string | null {
  const text = source.trim();
  if (!text || text.includes("\n")) return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return layOut(tokens(text));
}

/** Index just past the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/**
 * The text as whole string literals and single characters, with the whitespace
 * between tokens dropped, so `{ }` arrives as two adjacent tokens.
 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out.push(text.slice(i, end));
      i = end;
      continue;
    }
    if (!/\s/.test(text[i]!)) out.push(text[i]!);
    i++;
  }
  return out;
}

const CLOSER: Record<string, string> = { "{": "}", "[": "]" };

function layOut(toks: string[]): string {
  let out = "";
  let depth = 0;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (CLOSER[t]) {
      // Keep `{}` and `[]` on one line.
      if (toks[i + 1] === CLOSER[t]) {
        out += t + toks[++i];
        continue;
      }
      depth++;
      out += t + newline();
    } else if (t === "}" || t === "]") {
      depth--;
      out += newline() + t;
    } else if (t === ",") out += `,${newline()}`;
    else if (t === ":") out += ": ";
    else out += t;
  }
  return out;
}