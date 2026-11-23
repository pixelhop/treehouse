// Sign-up's optional "How did you hear about Treehouse?". The answer is stored
// on the user (`heardAbout`) and sent to PostHog as a person property, so keep
// the keys stable: renaming one splits the history in two. Labels can change.
export const HEARD_ABOUT_OPTIONS = [
  { value: "search", label: "Search (Google, Bing…)" },
  { value: "ai", label: "An AI assistant (ChatGPT, Claude…)" },
  { value: "social", label: "Social media" },
  { value: "friend", label: "A friend or colleague" },
  { value: "content", label: "A blog, newsletter or podcast" },
  { value: "other", label: "Somewhere else" },
] as const;

/**
 * What to store for a choice: the option key, or for "Somewhere else" the
 * person's own words after `other: ` (just `other` if they wrote nothing).
 * Undefined when nothing was chosen, so the field is left out of sign-up.
 */
export function heardAboutAnswer(choice: string, otherText: string): string | undefined {
  if (!choice) return undefined;
  if (choice !== "other") return choice;
  const words = otherText.trim();
  return words ? `other: ${words}` : "other";
}