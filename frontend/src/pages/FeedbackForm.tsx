import { useEffect, useState, type FormEvent } from "react";
import { api, type FeedbackSubmission } from "../lib/api";
import { Spinner } from "../components/Spinner";
import { BrandMark } from "../components/BrandMark";

const QUESTIONS: Array<{ key: keyof Omit<FeedbackSubmission, "comment">; label: string }> = [
  { key: "ratingOverall", label: "Overall, how satisfied are you with LazyRelay?" },
  { key: "ratingReliability", label: "How reliable has posting and scheduling been?" },
  { key: "ratingEase", label: "How easy was it to get started?" },
  { key: "ratingSupport", label: "How would you rate support, when you've needed it?" },
  { key: "ratingRecommend", label: "How likely are you to recommend LazyRelay to someone else?" },
];

function StarRating({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="feedback-stars" role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          className={`feedback-star${n <= value ? " feedback-star--filled" : ""}`}
          onClick={() => onChange(n)}
        >
          &#9733;
        </button>
      ))}
    </div>
  );
}

export function FeedbackForm({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .getFeedbackRequest(token)
      .then((r) => setAlreadySubmitted(r.alreadySubmitted))
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const missing = QUESTIONS.find((q) => !ratings[q.key]);
    if (missing) {
      setError("Please rate all five questions before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      await api.submitFeedback(token, {
        ratingOverall: ratings.ratingOverall,
        ratingReliability: ratings.ratingReliability,
        ratingEase: ratings.ratingEase,
        ratingSupport: ratings.ratingSupport,
        ratingRecommend: ratings.ratingRecommend,
        comment,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page auth-page--compact">
        <Spinner />
      </div>
    );
  }

  if (invalid) {
    return (
      <div className="auth-page auth-page--compact">
        <div className="auth-card">
          <BrandMark size={40} />
          <h1>This link isn't valid</h1>
          <p>It may have expired, or the address was copied incorrectly.</p>
        </div>
      </div>
    );
  }

  if (alreadySubmitted || done) {
    return (
      <div className="auth-page auth-page--compact">
        <div className="auth-card">
          <BrandMark size={40} />
          <h1>Thanks for the feedback</h1>
          <p>Really appreciate you taking the time.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page auth-page--compact">
      <div className="auth-card">
        <div className="wordmark">
          <BrandMark size={36} />
          <span style={{ fontSize: 22 }}>LazyRelay</span>
        </div>
        <p className="subtitle">Quick favor — five questions, click a star for each.</p>
        <form onSubmit={handleSubmit}>
          {QUESTIONS.map((q) => (
            <label key={q.key} className="feedback-question">
              {q.label}
              <StarRating value={ratings[q.key] ?? 0} onChange={(n) => setRatings((prev) => ({ ...prev, [q.key]: n }))} />
            </label>
          ))}
          <label>
            Anything else you'd like to tell us? (optional)
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Suggestions, things that could be better, anything at all"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Sending..." : "Submit feedback"}
          </button>
        </form>
      </div>
    </div>
  );
}
