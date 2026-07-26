interface PlatformIconProps {
  platform: string;
  size?: number;
  /** Dims the icon for a platform that isn't connectable yet (X, Reddit,
   *  or one missing local config) — applied by the caller's platform-picker
   *  grid, not decided in here. */
  comingSoon?: boolean;
}

// Each platform's real brand color, so the tile reads as that platform at a
// glance instead of a generic monochrome outline.
const BRAND_COLORS: Record<string, string> = {
  meta: "#1877F2",
  tiktok: "#000000",
  pinterest: "#E60023",
  youtube: "#FF0000",
  linkedin: "#0A66C2",
  telegram: "#26A5E4",
  facebook: "#1877F2",
  instagram: "#E4405F",
  mastodon: "#6364FF",
  bluesky: "#1185FE",
  threads: "#000000",
  discord: "#5865F2",
  tumblr: "#36465D",
  x: "#000000",
  reddit: "#FF4500",
};

function PlatformGlyph({ platform, size }: { platform: string; size: number }) {
  const color = BRAND_COLORS[platform] ?? "currentColor";
  switch (platform) {
    case "meta":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="M12 2C6.48 2 2 6.15 2 11.27c0 2.92 1.45 5.53 3.72 7.24V22l3.4-1.87c.91.25 1.87.39 2.88.39 5.52 0 10-4.15 10-9.25S17.52 2 12 2zm1.02 12.46-2.55-2.72-4.98 2.72 5.48-5.82 2.61 2.72 4.92-2.72-5.48 5.82z"
          />
        </svg>
      );
    case "tiktok":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#25F4EE"
            d="M15.9 7.2a5.9 5.9 0 0 0 3.6 1.5v3a8.14 8.14 0 0 1-3.6-1.02v6.05a5.87 5.87 0 1 1-5.05-5.82v3.02a2.72 2.72 0 1 0 1.95 2.61V2h2.9c.05.6.2 1.16.4 1.68"
          />
          <path
            fill="#FE2C55"
            d="M16.3 6.5a5.9 5.9 0 0 0 3.2 1.2v3a8.14 8.14 0 0 1-3.6-1.02V15.5a5.87 5.87 0 1 1-5.05-5.82v2.65a2.72 2.72 0 1 0 1.95 2.61V1.7h3.02c.05.6.2 1.16.48 1.7"
            opacity="0.75"
          />
          <path
            fill="#000000"
            d="M16.6 5.82c-.9-.98-1.4-2.26-1.4-3.6h-3.1v13.44c0 1.5-1.22 2.72-2.72 2.72a2.72 2.72 0 0 1 0-5.44c.28 0 .56.04.82.12V9.9a5.9 5.9 0 0 0-.82-.06 5.87 5.87 0 1 0 5.87 5.87V9.03a8.14 8.14 0 0 0 4.75 1.52V7.44a4.85 4.85 0 0 1-3.4-1.62z"
          />
        </svg>
      );
    case "pinterest":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="M12 2C6.48 2 2 6.48 2 12c0 4.24 2.63 7.86 6.35 9.32-.09-.79-.17-2.01.03-2.87.19-.79 1.22-5.02 1.22-5.02s-.31-.62-.31-1.54c0-1.45.84-2.53 1.88-2.53.89 0 1.32.67 1.32 1.46 0 .89-.57 2.22-.86 3.46-.24 1.03.52 1.88 1.54 1.88 1.85 0 3.09-2.38 3.09-5.19 0-2.14-1.44-3.74-4.06-3.74-2.96 0-4.81 2.21-4.81 4.68 0 .85.25 1.45.64 1.91.18.21.2.3.14.55-.05.19-.16.65-.21.83-.07.27-.28.37-.51.27-1.43-.58-2.1-2.15-2.1-3.91 0-2.91 2.45-6.39 7.3-6.39 3.9 0 6.47 2.82 6.47 5.85 0 4-2.22 6.99-5.5 6.99-1.1 0-2.13-.6-2.48-1.27l-.7 2.68c-.21.85-.79 1.9-1.24 2.55.97.29 1.99.44 3.05.44 5.52 0 10-4.48 10-10S17.52 2 12 2z"
          />
        </svg>
      );
    case "youtube":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="6" width="20" height="12" rx="4" fill={color} />
          <path fill="#fff" d="M10 9.5v5l4.5-2.5z" />
        </svg>
      );
    case "linkedin":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="3" fill={color} />
          <circle cx="7" cy="8" r="1.4" fill="#fff" />
          <rect x="5.8" y="10.5" width="2.4" height="8" fill="#fff" />
          <path
            fill="#fff"
            d="M11 10.5h2.3v1.2c.5-.8 1.4-1.4 2.7-1.4 2 0 3 1.3 3 3.7v4.5h-2.4v-4c0-1.1-.4-1.8-1.4-1.8-.9 0-1.5.6-1.7 1.2-.1.2-.1.5-.1.8v3.8H11z"
          />
        </svg>
      );
    case "telegram":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill={color} />
          <path fill="#fff" d="m5 12 14-6-2.3 13-4-3-2 2-.5-3.5L17 8 8 13.5z" />
        </svg>
      );
    case "facebook":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill={color} />
          <path fill="#fff" d="M13.5 21v-7h2.3l.3-2.7h-2.6V9.6c0-.8.2-1.3 1.3-1.3h1.4V5.9c-.2 0-1-.1-1.9-.1-1.9 0-3.2 1.2-3.2 3.3v1.9H8.8v2.7h2.3v7z" />
        </svg>
      );
    case "instagram":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#FFDC80" />
              <stop offset="30%" stopColor="#FCAF45" />
              <stop offset="55%" stopColor="#E1306C" />
              <stop offset="80%" stopColor="#C13584" />
              <stop offset="100%" stopColor="#833AB4" />
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig-grad)" />
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="#fff" strokeWidth="1.6" />
          <circle cx="17.1" cy="6.9" r="1.1" fill="#fff" />
        </svg>
      );
    case "mastodon":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="M19.3 6.6c-.4-2.6-2.6-4.6-5.2-5C12.4 1.3 11.6 1.3 10 1.6c-2.6.4-4.8 2.4-5.2 5-.4 2.4-.4 4.9 0 7.3.4 2.4 2.3 4.2 4.7 4.6.9.2 1.9.2 3 .1v-2.5c-.7.1-1.5.1-2.3-.1-1.2-.2-2.1-1.1-2.4-2.3-.1-.4-.1-.9-.1-1.5 1.2.6 2.5 1 3.9 1 1.5 0 2.9-.3 4.1-1 0 1.9-.1 3.3-.1 3.3s2.7-.4 3.5-2.5c.4-2.6.4-5-.8-6.4zM16.6 12h-2.1V7.8c0-.9-.4-1.4-1.1-1.4-.8 0-1.2.5-1.2 1.6v2.4h-2.1V8c0-1.1-.4-1.6-1.2-1.6-.7 0-1.1.5-1.1 1.4V12H5.6V7.6c0-1.7 1-3.1 2.9-3.1 1.1 0 2 .5 2.5 1.4.5-.9 1.4-1.4 2.5-1.4 1.9 0 2.9 1.4 2.9 3.1z"
          />
        </svg>
      );
    case "bluesky":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="M12 8.5c-1-2-3.7-4.3-5.9-4.9-1.2-.3-2.1.4-2.1 1.7 0 .9.1 4.9.2 5.7.3 2.4 2.8 3.1 5 2.8-3.3.4-6.1 1.6-2.3 5.8 4.1 4.2 5.6-1 6.1-2.5.5 1.5 1.6 6.6 6.1 2.5 3.6-4.2.9-5.4-2.4-5.8 2.2.3 4.7-.4 5-2.8.1-.8.2-4.8.2-5.7 0-1.3-.9-2-2.1-1.7-2.2.6-4.9 2.9-5.9 4.9z"
          />
        </svg>
      );
    case "threads":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="none"
            stroke={color}
            strokeWidth="1.7"
            strokeLinecap="round"
            d="M12 3c-5 0-8 3-8 9s3 9 8 9c4 0 6.5-2 6.5-5s-2-4.3-5-4.3c-2.3 0-3.7 1-3.7 2.5s1.3 2.3 3 2.1c1.8-.2 2.9-1.6 3-3.8.1-2.8-1.3-6.2-3.8-8"
          />
        </svg>
      );
    case "discord":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="M18.9 5.7A15 15 0 0 0 15.4 4.6l-.2.4a11.5 11.5 0 0 1 3 1.1 12.9 12.9 0 0 0-12.4 0 11 11 0 0 1 3.1-1.1l-.2-.4A15 15 0 0 0 5.1 5.7C3 8.9 2.4 12 2.7 15.1a15.2 15.2 0 0 0 4.5 2.2l.7-1.2a9.7 9.7 0 0 1-1.6-.8c.1-.1.3-.2.4-.3a10.9 10.9 0 0 0 10.6 0l.4.3a9.7 9.7 0 0 1-1.6.8l.7 1.2a15.1 15.1 0 0 0 4.5-2.2c.4-3.6-.5-6.7-2.4-9.4zM9.5 13.6c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7 1.5.8 1.5 1.7-.7 1.7-1.5 1.7zm5 0c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7 1.5.8 1.5 1.7-.6 1.7-1.5 1.7z"
          />
        </svg>
      );
    case "tumblr":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="M13.5 2.5v3.8h3.3v3H13.5v5.4c0 1.4.6 2 1.9 2 .5 0 1-.1 1.4-.2v3a8 8 0 0 1-2.7.5c-2.9 0-4.4-1.6-4.4-4.6V9.3H7.6v-2c1.6-.5 2.6-1.9 2.9-3.7l.1-1.1z"
          />
        </svg>
      );
    case "x":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill={color}
            d="m4 4 7.1 8.5L4.3 20h2.3l5.7-6.4L17 20h3l-7.4-8.8L19.8 4h-2.3l-5.4 6L7 4z"
          />
        </svg>
      );
    case "reddit":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="13.5" r="7.5" fill={color} />
          <circle cx="9" cy="13.5" r="1.2" fill="#fff" />
          <circle cx="15" cy="13.5" r="1.2" fill="#fff" />
          <path fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" d="M8.5 16.5c1 .8 2.2 1.2 3.5 1.2s2.5-.4 3.5-1.2" />
          <path fill="none" stroke={color} strokeWidth="1.3" d="M12 6V3.5m0 0 2.5 1" />
          <circle cx="12" cy="3.5" r="1" fill={color} />
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

export function PlatformIcon({ platform, size = 16, comingSoon = false }: PlatformIconProps) {
  return (
    <span style={comingSoon ? { opacity: 0.4, display: "inline-flex" } : { display: "inline-flex" }}>
      <PlatformGlyph platform={platform} size={size} />
    </span>
  );
}
