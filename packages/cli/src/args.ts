// Command-line argument helpers shared by the entry point.

/** Flags that take a value, so the value is never mistaken for a folder. */
const VALUE_FLAGS = new Set(["--api-base", "--workspace", "--lines", "-n"]);

/** The non-flag arguments, skipping the value that follows a value-taking flag. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("--")) out.push(a);
  }
  return out;
}