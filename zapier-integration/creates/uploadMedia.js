const FormData = require("form-data");

const BASE_URL = process.env.LAZYRELAY_API_BASE_URL || "https://lazyrelaylazyrelay-backend.onrender.com/api";

// Wraps POST /media/upload (backend/src/http/routes.ts:1383). The backend
// detects the real file type from magic bytes itself (fileTypeFromBuffer)
// and rejects anything outside jpeg/png/webp/gif/mp4/mov/webm, so the
// filename passed here doesn't need to be meaningful — a generic one is
// fine. Chain this action before "Schedule Post" and map its `url` output
// into that action's Media URL field.
const perform = async (z, bundle) => {
  // bundle.inputData.file is a URL Zapier itself hosts (it already pulled
  // the real file from wherever the Zap step upstream provided it) — fetch
  // the bytes, then forward as a real multipart upload, same shape a
  // browser's <input type="file"> would send.
  const fileResponse = await z.request({ url: bundle.inputData.file, raw: true });
  const buffer = await fileResponse.buffer();

  const form = new FormData();
  form.append("file", buffer, { filename: "upload" });
  if (bundle.inputData.altText) {
    form.append("altText", bundle.inputData.altText);
  }

  const response = await z.request({
    url: `${BASE_URL}/media/upload`,
    method: "POST",
    body: form,
  });

  return response.data;
};

module.exports = {
  key: "upload_media",
  noun: "Media",
  display: {
    label: "Upload Media",
    description: "Uploads an image or video to LazyRelay so it can be attached to a scheduled post. Optional — only needed when a Zap should attach a file.",
  },
  operation: {
    perform,
    inputFields: [
      { key: "file", label: "File", type: "file", required: true, helpText: "Image (jpeg/png/webp/gif) or video (mp4/mov/webm)." },
      { key: "altText", label: "Alt Text", type: "string", required: false, helpText: "Optional accessibility description." },
    ],
    sample: {
      id: "8a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
      url: "https://lazyrelay.example.supabase.co/storage/v1/object/public/post-media/account-id/file.jpg",
      altText: null,
    },
  },
};
