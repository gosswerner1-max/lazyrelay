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

/** A box for a comma-separated list (tags, categories). Keeps what the customer is typing, hands the parsed list up. */
function ListInput({ label, initial, onList }: { label: string; initial: string[]; onList: (items: string[]) => void }) {
  const [text, setText] = useState(initial.join(", "));
  return (
    <label className="field">
      {label}
      <input
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onList(parseTagList(e.target.value));
        }}
      />
    </label>
  );
}

export function PlatformOptions({ groups, value, onChange, mediaUrl, hasExtraMedia, onError }: Props) {
  const [tagsText, setTagsText] = useState((value.youtube?.tags ?? []).join(", "));
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const set = <K extends keyof PostOptions>(key: K, patch: PostOptions[K]) => onChange({ ...value, [key]: patch });

  const anything = groups.tiktok || groups.youtube || groups.instagram || groups.facebook || groups.linkedin || groups.wordpress || groups.devto || groups.hashnode || groups.lemmy || groups.chainPlatforms.length > 0;
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

      {groups.wordpress && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("wordpress")}</strong>
          <label className="field">
            Title (optional, otherwise the first line of the post is the title)
            <input type="text" maxLength={250} value={value.wordpress?.title ?? ""} onChange={(e) => set("wordpress", { ...value.wordpress, title: e.target.value })} />
          </label>
          <label className="field">
            When it goes out
            <select value={value.wordpress?.status ?? "publish"} onChange={(e) => set("wordpress", { ...value.wordpress, status: e.target.value as "publish" | "draft" })}>
              <option value="publish">Publish it</option>
              <option value="draft">Save as a draft on my site</option>
            </select>
          </label>
          <ListInput label="Categories (optional, separated by commas)" initial={value.wordpress?.categories ?? []} onList={(items) => set("wordpress", { ...value.wordpress, categories: items })} />
          <ListInput label="Tags (optional, separated by commas)" initial={value.wordpress?.tags ?? []} onList={(items) => set("wordpress", { ...value.wordpress, tags: items })} />
          <p className="section-note">The post text becomes the article. If you attach an image it is used as the featured image.</p>
        </div>
      )}

      {groups.devto && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("devto")}</strong>
          <label className="field">
            Title (optional, otherwise the first line of the post is the title)
            <input type="text" maxLength={250} value={value.devto?.title ?? ""} onChange={(e) => set("devto", { ...value.devto, title: e.target.value })} />
          </label>
          <label className="field">
            When it goes out
            <select value={value.devto?.published === false ? "draft" : "publish"} onChange={(e) => set("devto", { ...value.devto, published: e.target.value === "publish" })}>
              <option value="publish">Publish it</option>
              <option value="draft">Save as a draft on dev.to</option>
            </select>
          </label>
          <ListInput label="Tags (up to 4, separated by commas)" initial={value.devto?.tags ?? []} onList={(items) => set("devto", { ...value.devto, tags: items })} />
          <label className="field">
            Series (optional)
            <input type="text" maxLength={100} value={value.devto?.series ?? ""} onChange={(e) => set("devto", { ...value.devto, series: e.target.value })} />
          </label>
          <label className="field">
            Original address if this was first published elsewhere (optional)
            <input type="text" placeholder="https://..." value={value.devto?.canonicalUrl ?? ""} onChange={(e) => set("devto", { ...value.devto, canonicalUrl: e.target.value })} />
          </label>
          <p className="section-note">dev.to takes markdown. Images are shown as pictures in the article; video is not supported.</p>
        </div>
      )}

      {groups.hashnode && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("hashnode")}</strong>
          <label className="field">
            Title (optional, otherwise the first line of the post is the title)
            <input type="text" maxLength={250} value={value.hashnode?.title ?? ""} onChange={(e) => set("hashnode", { ...value.hashnode, title: e.target.value })} />
          </label>
          <label className="field">
            Subtitle (optional)
            <input type="text" maxLength={250} value={value.hashnode?.subtitle ?? ""} onChange={(e) => set("hashnode", { ...value.hashnode, subtitle: e.target.value })} />
          </label>
          <ListInput label="Tags (up to 5, separated by commas)" initial={value.hashnode?.tags ?? []} onList={(items) => set("hashnode", { ...value.hashnode, tags: items })} />
          <label className="field">
            Original address if this was first published elsewhere (optional)
            <input type="text" placeholder="https://..." value={value.hashnode?.canonicalUrl ?? ""} onChange={(e) => set("hashnode", { ...value.hashnode, canonicalUrl: e.target.value })} />
          </label>
          <label className="field-check">
            <input type="checkbox" checked={value.hashnode?.draft === true} onChange={(e) => set("hashnode", { ...value.hashnode, draft: e.target.checked })} />
            Save as a draft on Hashnode instead of publishing
          </label>
          <p className="section-note">Hashnode takes markdown. An attached image is used as the cover; video is not supported.</p>
        </div>
      )}

      {groups.lemmy && (
        <div style={box}>
          <strong className="options-group-name">{platformLabel("lemmy")}</strong>
          <label className="field">
            Community (for example programming@programming.dev, leave empty to use the one you saved when connecting)
            <input type="text" value={value.lemmy?.community ?? ""} onChange={(e) => set("lemmy", { ...value.lemmy, community: e.target.value })} />
          </label>
          <label className="field">
            Title (optional, otherwise the first line of the post is the title)
            <input type="text" maxLength={200} value={value.lemmy?.title ?? ""} onChange={(e) => set("lemmy", { ...value.lemmy, title: e.target.value })} />
          </label>
          <label className="field">
            Link to share (optional)
            <input type="text" placeholder="https://..." value={value.lemmy?.url ?? ""} onChange={(e) => set("lemmy", { ...value.lemmy, url: e.target.value })} />
          </label>
          <label className="field-check">
            <input type="checkbox" checked={value.lemmy?.nsfw === true} onChange={(e) => set("lemmy", { ...value.lemmy, nsfw: e.target.checked })} />
            Mark as NSFW
          </label>
          <p className="section-note">Each Lemmy community has its own rules. Check them before posting there.</p>
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
