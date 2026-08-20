const DAYS = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 7 },
];

interface DayOfWeekPickerProps {
  selected: number[];
  onToggle: (day: number) => void;
}

// A row of toggle chips, same pill visual language as the suggested-time
// chips in DateTimePicker — replaces a vertical checkbox list that was
// left over from before the calendar/scheduling UI was redesigned.
export function DayOfWeekPicker({ selected, onToggle }: DayOfWeekPickerProps) {
  return (
    <div className="day-of-week-picker">
      {DAYS.map((d) => (
        <button
          type="button"
          key={d.value}
          className={`day-of-week-chip${selected.includes(d.value) ? " day-of-week-chip-active" : ""}`}
          onClick={() => onToggle(d.value)}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}
