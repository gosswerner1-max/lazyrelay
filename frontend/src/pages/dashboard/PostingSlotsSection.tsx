import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { describeSlot, type PostingSlotList } from "../../lib/postingSlots";

// Settings > Posting times: the times you like to post. The composer's "Use my
// next free time" picks the first one no post on that channel already uses.

interface Props {
  onError: (message: string | null) => void;
}

const DAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

export function PostingSlotsSection({ onError }: Props) {
  const [list, setList] = useState<PostingSlotList | null>(null);
  const [days, setDays] = useState<number[]>([1, 3, 5]);
  const [time, setTime] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const load = useCallback(async () => {
    try {
      setList(await api.listPostingSlots());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await action();
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    await run(() => api.createPostingSlot({ daysOfWeek: days, timeOfDay: time, timezone }));
  }

  const atLimit = !!list && list.slots.length >= list.maxSlots;

  return (
    <section>
      <h2>Posting times</h2>
      <p className="section-note">
        Save the times you like to post. When you write a post, "Use my next free time" fills in the first of these times that
        has nothing else scheduled on that account. Times are in your time zone ({timezone}).
      </p>

      {list && list.slots.length === 0 && <p className="empty">No posting times yet.</p>}
      {list?.slots.map((s) => (
        <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
          <span>{describeSlot(s)}</span>
          <button type="button" className="btn-outline" disabled={busy} onClick={() => run(() => api.deletePostingSlot(s.id))}>
            Delete
          </button>
        </div>
      ))}

      <form onSubmit={handleAdd} className="settings-form">
        <div className="settings-day-row">
          {DAYS.map((d) => (
            <label key={d.n} className="field-check">
              <input
                type="checkbox"
                checked={days.includes(d.n)}
                onChange={(e) => setDays((prev) => (e.target.checked ? [...prev, d.n] : prev.filter((x) => x !== d.n)))}
              />
              {d.label}
            </label>
          ))}
        </div>
        <label>
          Time
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || atLimit || days.length === 0 || !time}>
          {atLimit ? "Posting time limit reached" : "Save posting time"}
        </button>
      </form>
    </section>
  );
}
