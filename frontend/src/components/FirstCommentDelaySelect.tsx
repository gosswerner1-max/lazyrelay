import { FIRST_COMMENT_DELAY_OPTIONS, showFirstCommentDelay } from "../lib/firstCommentDelay";

/** "Post the comment" choice next to the first comment field. Hidden until a first comment is typed and a
 *  chosen account (Facebook or Instagram) can hold it back. */
export function FirstCommentDelaySelect({
  firstComment,
  platforms,
  value,
  onChange,
}: {
  firstComment: string | null | undefined;
  platforms: Array<string | undefined>;
  value: number;
  onChange: (minutes: number) => void;
}) {
  if (!showFirstCommentDelay(firstComment, platforms)) return null;
  return (
    <label>
      Post the comment
      <select aria-label="Post the comment" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {FIRST_COMMENT_DELAY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="section-note">Waiting a while before the comment is a common way to keep people talking on your post.</span>
    </label>
  );
}
