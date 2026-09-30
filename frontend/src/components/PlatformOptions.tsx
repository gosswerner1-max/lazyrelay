import { useState } from "react";
import { api } from "../lib/api";
import { chainLimitFor, MAX_CHAIN_ITEMS, parseTagList, platformLabel, type OptionGroups, type PostOptions } from "../lib/postOptions";
import { isVideoFile } from "../lib/carousel";

// Composer panel for the settings only one platform understands. Shows a group only
// for the platforms selected right now (see lib/postOptions.ts optionGroupsFor).

interface Props {
  groups: OptionGroups;
  value: PostOptions;
  onChange: (next: PostOptions) => void;
  mediaUrl: string | null;
  hasExtraMedia: boolean;
  onError: (message: string | null) => void;
}

const box: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 };

export function PlatformOptions({ groups, value, onChange, mediaUrl, hasExtraMedia, onError }: Props) {
  const [tagsText, setTagsText] = useState((value.youtube?.tags ?? []).join(", "));
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const set = <K extends keyof PostOptions>(key: K, patch: PostOptions[K]) => onChange({ ...value, [key]: patch });

  const anything = groups.tiktok || groups.youtube || groups.instagram || groups.facebook || groups.linkedin || groups.chainPlatforms.length > 0;
  if (!anything) return null;

  const video = !!mediaUrl && isVideoFile(mediaUrl);
  const chain = value.chain ?? [];
  const limit = chainLimitFor(groups.chainPlatforms);

  async function handlePdf(file: File) {
    onError(null);
    setUploadingPdf(true);
    try {
      const { url } = await api.uploadMedia(file);
      set("linkedin", { ...value.linkedin, documentUrl: url });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingPdf(false);
    }
  }

  return (
    <div>
      <h3 className="options-title">Platform options</h3>

      {groups.tiktok && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("tiktok")}</strong>
          <label className="field-check">
            <input type="checkbox" checked={value.tiktok?.aiGenerated === true} onChange={(e) => set("tiktok", { ...value.tiktok, aiGenerated: e.target.checked })} />
            This video is AI-generated (adds TikTok's AI label)
          </label>
        </div>
      )}

      {groups.youtube && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("youtube")}</strong>
          <label className="field">
            Video title (optional, the post text is the description)
            <input type="text" maxLength={100} value={value.youtube?.title ?? ""} onChange={(e) => set("youtube", { ...value.youtube, title: e.target.value })} />
          </label>
          <label className="field">
            Who can see it
            <select value={value.youtube?.privacy ?? "public"} onChange={(e) => set("youtube", { ...value.youtube, privacy: e.target.value as "public" | "unlisted" | "private" })}>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted (anyone with the link)</option>
              <option value="private">Private (only you)</option>
            </select>
          </label>
          <label className="field">
            Made for kids?
            <select
              value={value.youtube?.madeForKids === undefined ? "" : value.youtube.madeForKids ? "yes" : "no"}
              onChange={(e) => {
                const v = e.target.value;
                const next = { ...value.youtube };
                if (v === "") delete next.madeForKids;
                else next.madeForKids = v === "yes";
                set("youtube", next);
              }}
            >
              <option value="">Use my channel setting</option>
              <option value="no">No, it is not made for kids</option>
              <option value="yes">Yes, it is made for kids</option>
            </select>
          </label>
          <label className="field">
            Tags (optional, separated by commas)
            <input
              type="text"
              value={tagsText}
              onChange={(e) => {
                setTagsText(e.target.value);
                set("youtube", { ...value.youtube, tags: parseTagList(e.target.value) });
              }}
            />
          </label>
          <label className="field-check">
            <input type="checkbox" checked={value.youtube?.aiGenerated === true} onChange={(e) => set("youtube", { ...value.youtube, aiGenerated: e.target.checked })} />
            Realistic content made or changed with AI (YouTube's disclosure)
          </label>
        </div>
      )}

      {groups.instagram && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("instagram")}</strong>
          <label className="field">
            Post as
            <select
              value={value.instagram?.placement ?? ""}
              onChange={(e) => {
                const p = e.target.value as "" | "reel" | "story";
                const next = { ...value.instagram };
                if (p === "") delete next.placement;
                else next.placement = p;
                if (p === "story") {
                  delete next.trialReel;
                  delete next.trialGraduation;
                }
                set("instagram", next);
              }}
            >
              <option value="">{video ? "Reel (the default for a video)" : "Feed post"}</option>
              {video && <option value="reel">Reel</option>}
              {mediaUrl && !hasExtraMedia && <option value="story">Story</option>}
            </select>
          </label>
          {video && !hasExtraMedia && value.instagram?.placement !== "story" && (
            <>
              <label className="field-check">
                <input
                  type="checkbox"
                  checked={value.instagram?.trialReel === true}
                  onChange={(e) => {
                    const next = { ...value.instagram, trialReel: e.target.checked };
                    if (!e.target.checked) delete next.trialGraduation;
                    set("instagram", next);
                  }}
                />
                Trial reel (shown to people who do not follow you first)
              </label>
              {value.instagram?.trialReel && (
                <label className="field">
                  Move it to your followers
                  <select value={value.instagram.trialGraduation ?? "manual"} onChange={(e) => set("instagram", { ...value.instagram, trialGraduation: e.target.value as "manual" | "auto" })}>
                    <option value="manual">I will do it myself in Instagram</option>
                    <option value="auto">Automatically when it does well</option>
                  </select>
                </label>
              )}
            </>
          )}
          {value.instagram?.placement === "story" && <p className="section-note">Instagram Stories are one image or video and do not show the post text.</p>}
        </div>
      )}

      {groups.facebook && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("facebook")}</strong>
          <label className="field">
            Post as
            <select value={value.facebook?.placement ?? "feed"} onChange={(e) => set("facebook", { placement: e.target.value as "feed" | "story" })}>
              <option value="feed">Normal post</option>
              {mediaUrl && !hasExtraMedia && <option value="story">Story</option>}
            </select>
          </label>
          {value.facebook?.placement === "story" && <p className="section-note">A Facebook Story is one image or video.</p>}
        </div>
      )}

      {groups.linkedin && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("linkedin")}</strong>
          {value.linkedin?.documentUrl ? (
            <div>
              <p className="section-note">PDF attached. It shows as a swipeable document.</p>
              <button type="button" className="btn-outline" onClick={() => onChange({ ...value, linkedin: undefined })}>
                Remove the PDF
              </button>
              <label className="field">
                Document title (optional)
                <input type="text" maxLength={100} value={value.linkedin.documentTitle ?? ""} onChange={(e) => set("linkedin", { ...value.linkedin, documentTitle: e.target.value })} />
              </label>
            </div>
          ) : (
            <label className="btn-outline" style={{ display: "inline-block", cursor: "pointer", width: "fit-content" }}>
              {uploadingPdf ? "Uploading..." : "Attach a PDF document"}
              <input
                type="file"
                accept="application/pdf"
                hidden
                disabled={uploadingPdf || !!mediaUrl}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handlePdf(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
          {!value.linkedin?.documentUrl && mediaUrl && <p className="section-note">A LinkedIn post can carry a PDF or images, not both. Remove the image to attach a PDF.</p>}
        </div>
      )}

      {groups.chainPlatforms.length > 0 && (
        <div style={box}>
          <strong>Thread ({groups.chainPlatforms.map(platformLabel).join(", ")})</strong>
          <p className="section-note">
            Add follow-up posts that reply to the first one, in order. Each can be up to {limit} characters. They are posted after the first post is confirmed live.
          </p>
          {chain.map((text, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <textarea
                style={{ flex: 1 }}
                maxLength={limit}
                placeholder={`Follow-up ${i + 1}`}
                value={text}
                onChange={(e) => set("chain", chain.map((t, j) => (j === i ? e.target.value : t)))}
              />
              <button type="button" className="btn-outline" onClick={() => set("chain", chain.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {chain.length < MAX_CHAIN_ITEMS && (
            <button type="button" className="btn-outline" style={{ width: "fit-content" }} onClick={() => set("chain", [...chain, ""])}>
              Add a follow-up post
            </button>
          )}
        </div>
      )}
    </div>
  );
}
