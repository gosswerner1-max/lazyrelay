// Saved snippets: reusable text a customer inserts into a post (backend 0099).

export interface Snippet {
  id: string;
  name: string;
  content: string;
  isSignature: boolean;
  createdAt: string;
}

export interface SnippetList {
  maxSnippets: number;
  snippets: Snippet[];
}

/** Adds a snippet to the end of the post text on its own paragraph. Never adds the same text twice in a row. */
export function insertSnippet(current: string, snippet: string): string {
  const text = snippet.trim();
  if (!text) return current;
  if (current.trimEnd().endsWith(text)) return current;
  if (!current.trim()) return text;
  return `${current.trimEnd()}\n\n${text}`;
}
