// A live phone-mockup preview of the actual post -- built 2026-09-15 for
// TikTok only (Werner's request after seeing TikTok Studio's own upload
// screen), then generalized the same day on his follow-up request to work
// for every connected platform, not just TikTok. Deliberately one shared
// visual (icon/accent color per platform, via PlatformIcon/BRAND_COLORS)
// rather than 13 bespoke pixel-perfect native mockups -- showing customers
// their real media + caption together is the actual value here, not
// replicating each platform's exact UI chrome.
import { PlatformIcon } from "./PlatformIcon";

interface SocialPostPreviewProps {
  platform: string;
  displayName: string;
  mediaUrl: string | null;
  caption: string;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov)$/i.test(url);
}

export function SocialPostPreview({ platform, displayName, mediaUrl, caption }: SocialPostPreviewProps) {
  return (
    <div className="social-preview-phone">
      <div className="social-preview-media">
        {mediaUrl ? (
          isVideoUrl(mediaUrl) ? (
            <video src={mediaUrl} muted loop autoPlay playsInline />
          ) : (
            <img src={mediaUrl} alt="" />
          )
        ) : (
          <div className="social-preview-empty">Add media to see a preview</div>
        )}
      </div>
      <div className="social-preview-overlay">
        <div className="social-preview-username">@{displayName}</div>
        <div className="social-preview-caption">{caption || "Your caption will appear here"}</div>
      </div>
      <div className="social-preview-sidebar">
        <span className="social-preview-icon">♥</span>
        <span className="social-preview-icon">💬</span>
        <span className="social-preview-icon">↗</span>
      </div>
      <div className="social-preview-badge">
        <PlatformIcon platform={platform} size={14} />
      </div>
    </div>
  );
}
