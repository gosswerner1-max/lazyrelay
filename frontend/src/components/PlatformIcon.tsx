interface PlatformIconProps {
  platform: string;
  size?: number;
}

export function PlatformIcon({ platform, size = 16 }: PlatformIconProps) {
  switch (platform) {
    case "meta":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2C6.48 2 2 6.15 2 11.27c0 2.92 1.45 5.53 3.72 7.24V22l3.4-1.87c.91.25 1.87.39 2.88.39 5.52 0 10-4.15 10-9.25S17.52 2 12 2zm1.02 12.46-2.55-2.72-4.98 2.72 5.48-5.82 2.61 2.72 4.92-2.72-5.48 5.82z"
          />
        </svg>
      );
    case "tiktok":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.6 5.82c-.9-.98-1.4-2.26-1.4-3.6h-3.1v13.44c0 1.5-1.22 2.72-2.72 2.72a2.72 2.72 0 0 1 0-5.44c.28 0 .56.04.82.12V9.9a5.9 5.9 0 0 0-.82-.06 5.87 5.87 0 1 0 5.87 5.87V9.03a8.14 8.14 0 0 0 4.75 1.52V7.44a4.85 4.85 0 0 1-3.4-1.62z"
          />
        </svg>
      );
    case "pinterest":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2C6.48 2 2 6.48 2 12c0 4.24 2.63 7.86 6.35 9.32-.09-.79-.17-2.01.03-2.87.19-.79 1.22-5.02 1.22-5.02s-.31-.62-.31-1.54c0-1.45.84-2.53 1.88-2.53.89 0 1.32.67 1.32 1.46 0 .89-.57 2.22-.86 3.46-.24 1.03.52 1.88 1.54 1.88 1.85 0 3.09-2.38 3.09-5.19 0-2.14-1.44-3.74-4.06-3.74-2.96 0-4.81 2.21-4.81 4.68 0 .85.25 1.45.64 1.91.18.21.2.3.14.55-.05.19-.16.65-.21.83-.07.27-.28.37-.51.27-1.43-.58-2.1-2.15-2.1-3.91 0-2.91 2.45-6.39 7.3-6.39 3.9 0 6.47 2.82 6.47 5.85 0 4-2.22 6.99-5.5 6.99-1.1 0-2.13-.6-2.48-1.27l-.7 2.68c-.21.85-.79 1.9-1.24 2.55.97.29 1.99.44 3.05.44 5.52 0 10-4.48 10-10S17.52 2 12 2z"
          />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}
