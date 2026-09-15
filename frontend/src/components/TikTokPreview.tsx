// A live phone-mockup preview of the actual post, next to the TikTok
// section of the compose form -- built 2026-09-15 on Werner's request after
// seeing TikTok Studio's own upload screen: customers should be able to see
// how their post will actually look (media + caption together) before
// posting, not just a small isolated thumbnail. Scoped to TikTok for now,
// not the other 12 platforms -- extend the same pattern later if it earns
// its keep here first.

interface TikTokPreviewProps {
  mediaUrl: string | null;
  caption: string;
  nickname: string;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov)$/i.test(url);
}

export function TikTokPreview({ mediaUrl, caption, nickname }: TikTokPreviewProps) {
  return (
    <div className="tiktok-preview-phone">
      <div className="tiktok-preview-media">
        {mediaUrl ? (
          isVideoUrl(mediaUrl) ? (
            <video src={mediaUrl} muted loop autoPlay playsInline />
          ) : (
            <img src={mediaUrl} alt="" />
          )
        ) : (
          <div className="tiktok-preview-empty">Add media to see a preview</div>
        )}
      </div>
      <div className="tiktok-preview-overlay">
        <div className="tiktok-preview-username">@{nickname}</div>
        <div className="tiktok-preview-caption">{caption || "Your caption will appear here"}</div>
      </div>
      <div className="tiktok-preview-sidebar">
        <span className="tiktok-preview-icon">♥</span>
        <span className="tiktok-preview-icon">💬</span>
        <span className="tiktok-preview-icon">↗</span>
      </div>
    </div>
  );
}
