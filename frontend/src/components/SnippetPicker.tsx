import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { insertSnippet, type Snippet } from "../lib/snippets";

// Composer control: drop a saved snippet (or the signature) into the post box.
// Shows nothing at all until the customer has saved at least one snippet.

interface Props {
  content: string;
  setContent: (value: string) => void;
}

export function SnippetPicker({ content, setContent }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .listSnippets()
      .then((r) => alive && setSnippets(r.snippets))
      .catch(() => {}); // a missing list must never get in the way of writing a post
    return () => {
      alive = false;
    };
  }, []);

  if (snippets.length === 0) return null;
  const signature = snippets.find((s) => s.isSignature);

  return (
    <div className="hashtag-suggest-row" style={{ flexWrap: "wrap", gap: 6 }}>
      {signature && (
        <button type="button" className="btn-outline" onClick={() => setContent(insertSnippet(content, signature.content))}>
          Add signature
        </button>
      )}
      <select
        aria-label="Insert a saved snippet"
        value=""
        onChange={(e) => {
          const s = snippets.find((x) => x.id === e.target.value);
          if (s) setContent(insertSnippet(content, s.content));
        }}
      >
        <option value="">Insert snippet...</option>
        {snippets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}
