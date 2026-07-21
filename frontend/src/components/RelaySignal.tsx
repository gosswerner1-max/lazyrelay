interface RelaySignalProps {
  size?: number;
  pulsing?: boolean;
}

export function RelaySignal({ size = 28, pulsing = false }: RelaySignalProps) {
  return (
    <svg
      className={pulsing ? "relay-signal relay-signal--pulsing" : "relay-signal"}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
    >
      <circle className="relay-signal__ring relay-signal__ring--outer" cx="20" cy="20" r="13" fill="none" strokeWidth="2" />
      <circle className="relay-signal__ring relay-signal__ring--inner" cx="20" cy="20" r="7.5" fill="none" strokeWidth="2" />
      <circle className="relay-signal__dot" cx="20" cy="20" r="3" />
    </svg>
  );
}
