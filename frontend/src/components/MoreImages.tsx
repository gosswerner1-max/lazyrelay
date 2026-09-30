import { useState } from "react";
import { api } from "../lib/api";
import { MAX_EXTRA_IMAGES } from "../lib/carousel";

// Composer control for an Instagram carousel: the main image is the first
// slide, these are the rest (up to 9 more). Uploads go straight to the media
// library like any other image.

interface Props {
  urls: string[];
  setUrls: (urls: string[]) => void;
  onError: (message: string | null) => void;
}

export function MoreImages({ urls, setUrls, onError }: Props) {
  const [uploading, setUploading] = useState(false);

  async function handleFiles(files: FileList) {
    onError(null);
    setUploading(true);
    try {
      const added: string[] = [];
      for (const file of Array.from(files).slice(0, MAX_EXTRA_IMAGES - urls.length)) {
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
        Instagram carousel (optional): add up to {MAX_EXTRA_IMAGES} more images after the main one. They show as slides in the
        order added. Images only, no videos.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {urls.map((u, i) => (
          <div key={u + i} className="media-preview" style={{ width: 90 }}>
            <img src={u} alt={`Carousel image ${i + 2}`} />
            <button type="button" className="media-remove" onClick={() => setUrls(urls.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
      </div>
      {urls.length < MAX_EXTRA_IMAGES && (
        <label className="btn-outline" style={{ display: "inline-block", marginTop: 8, cursor: "pointer" }}>
          {uploading ? "Uploading..." : "Add more images"}
          <input
            type="file"
            accept="image/jpeg,image/png"
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
