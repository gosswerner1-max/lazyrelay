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
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#000000" />
          <path
            fill="#25F4EE"
            d="M14.4 6.2a4 4 0 0 0 2.5 1v2a5.9 5.9 0 0 1-2.5-.68v4.2a4.05 4.05 0 1 1-3.5-4.02v2.02a2 2 0 1 0 1.4 1.9V4.6h2.02c.03.4.13.78.28 1.14"
          />
          <path
            fill="#FE2C55"
            d="M14.7 5.8a4 4 0 0 0 2.2.86v2a5.9 5.9 0 0 1-2.5-.68v4.32a4.05 4.05 0 1 1-3.5-4.02v2c-.14-.03-.28-.05-.4-.05a1.94 1.94 0 0 0 0 3.88 1.94 1.94 0 0 0 1.9-2V4.4h2.12c.02.42.1.82.24 1.2"
            opacity="0.7"
          />
          <path
            fill="#ffffff"
            d="M14.9 5.5a4 4 0 0 0 2.5 2.5v2a5.9 5.9 0 0 1-2.5-.9v4.5a4.05 4.05 0 1 1-4.05-4.05c.14 0 .28 0 .42.02v2.02a2 2 0 1 0 1.4 1.9V4.2h2.14c.02.46.1.9.24 1.3z"
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
          <rect x="1" y="1" width="22" height="22" rx="6" fill={color} />
          <path
            transform="translate(4.7 4.5) scale(0.62)"
            fill="#fff"
            d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.001v-.001c.028-3.586.879-6.437 2.524-8.492C5.845 1.205 8.598.024 12.18 0h.007c2.751.02 5.045.725 6.826 2.098 1.677 1.29 2.858 3.13 3.508 5.467l-2.04.58c-1.114-4.01-3.918-6.06-8.318-6.09-2.892.021-5.058.943-6.462 2.727-1.35 1.712-2.05 4.148-2.078 7.223.028 3.075.728 5.512 2.078 7.226 1.404 1.782 3.57 2.704 6.462 2.725 2.6-.018 4.317-.638 5.74-2.077 1.622-1.638 1.594-3.643 1.09-4.928-.298-.766-.826-1.428-1.545-1.949-.153.998-.475 1.789-.969 2.394-.647.792-1.548 1.234-2.66 1.313-1.16.076-2.23-.243-2.988-.897-.8-.688-1.24-1.712-1.24-2.882 0-2.31 1.755-3.983 4.372-4.15.938-.06 1.771.048 2.517.324a4.94 4.94 0 0 0-.104-1.166c-.281-1.353-1.28-2.028-2.972-2.008-.986.011-1.752.386-2.279 1.115l-1.677-1.17c.87-1.215 2.176-1.882 3.877-1.985 2.902-.176 4.85.995 5.475 3.303.196.72.253 1.508.17 2.35l-.011.11c.986.746 1.741 1.68 2.207 2.73.822 1.848.86 4.6-1.395 6.83-1.827 1.81-4.234 2.686-7.171 2.686z"
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
          <rect x="2" y="2" width="20" height="20" rx="6" fill={color} />
          <path
            fill="#fff"
            d="M13.5 4.5v3.3h3.3v2.8h-3.3v4.7c0 1.2.5 1.7 1.6 1.7.4 0 .9-.1 1.2-.2v2.7a7 7 0 0 1-2.4.4c-2.5 0-3.8-1.4-3.8-4V10.6H8.4V8.3c1.4-.4 2.3-1.7 2.5-3.3l.1-.5z"
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
