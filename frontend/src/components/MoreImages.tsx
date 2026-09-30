import { useState } from "react";
import { api } from "../lib/api";
import { isVideoFile, type CarouselPlan } from "../lib/carousel";

// Composer control for a multi-image post: the main file is the first item, these
// are the rest. Uploads go straight to the media library like any other file. The
// limits come from the platforms selected (see lib/carousel.ts).

interface Props {
  plan: CarouselPlan;
  urls: string[];
  setUrls: (urls: string[]) => void;
  onError: (message: string | null) => void;
}

export function MoreImages({ plan, urls, setUrls, onError }: Props) {
  const [uploading, setUploading] = useState(false);
  const room = Math.max(0, plan.maxExtra - urls.length);

  async function handleFiles(files: FileList) {
    onError(null);
    setUploading(true);
    try {
      const added: string[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        const { url } = await api.uploadMedia(file);
        added.push(url);
      }
      setUrls([...urls, ...added]);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <p className="section-note">
        More images (optional). {plan.note} They show in the order added.
        {urls.length > plan.maxExtra && " You have more than these platforms allow, so remove some before posting."}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {urls.map((u, i) => (
          <div key={u + i} className="media-preview" style={{ width: 90 }}>
            {isVideoFile(u) ? <video src={u} muted /> : <img src={u} alt={`Item ${i + 2}`} />}
            <button type="button" className="media-remove" onClick={() => setUrls(urls.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
      </div>
      {room > 0 && (
        <label className="btn-outline" style={{ display: "inline-block", marginTop: 8, cursor: "pointer" }}>
          {uploading ? "Uploading..." : "Add more"}
          <input
            type="file"
            accept={plan.videosAllowed ? "image/jpeg,image/png,video/mp4,video/quicktime" : "image/jpeg,image/png"}
            multiple
            hidden
            disabled={uploading}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      )}
    </div>
  );
}
