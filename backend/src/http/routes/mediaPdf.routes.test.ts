// PDF uploads for LinkedIn documents: allowed, size-capped, and stored with the real type.
// Login, storage and file-type detection are mocked; nothing real is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { tables } from "../../testFakeSupabase.js";

const detect = vi.hoisted(() => ({ result: { mime: "application/pdf", ext: "pdf" } as { mime: string; ext: string } | undefined }));
const uploads = vi.hoisted(() => ({ calls: [] as Array<{ path: string; contentType: string }> }));

vi.mock("file-type", () => ({ fileTypeFromFile: async () => detect.result }));
vi.mock("image-size/fromFile", () => ({ imageSizeFromFile: async () => ({ width: 1, height: 1 }) }));
vi.mock("../auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.accountId = "acc1";
    next();
  },
}));
vi.mock("../rateLimit.js", () => ({ tieredRateLimit: (_req: any, _res: any, next: any) => next() }));
vi.mock("../../storageQuota.js", () => ({ checkQuotaForNewUpload: async () => null, getStorageUsage: async () => ({}) }));
vi.mock("../../supabase.js", async () => {
  const f = await import("../../testFakeSupabase.js");
  return {
    supabase: {
      from: (t: string) => f.makeBuilder(t),
      storage: {
        from: () => ({
          upload: async (path: string, body: AsyncIterable<unknown>, opts: { contentType: string }) => {
            // Read the stream to the end like the real storage client does, so the temp file is not deleted mid-read.
            for await (const _chunk of body) void _chunk;
            uploads.calls.push({ path, contentType: opts.contentType });
            return { error: null };
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example.com/${path}` } }),
        }),
      },
    },
  };
});

const { buildMediaRouter, PDF_MAX_BYTES } = await import("./media.routes.js");
const app = () => {
  const a = express();
  a.use(buildMediaRouter());
  return a;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  uploads.calls = [];
  detect.result = { mime: "application/pdf", ext: "pdf" };
});

describe("POST /media/upload with a PDF", () => {
  it("accepts a PDF and stores it with its real type and a .pdf name", async () => {
    const r = await request(app()).post("/media/upload").attach("file", Buffer.from("%PDF-1.4 fake"), "deck.pdf");
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/\.pdf$/);
    expect(uploads.calls[0].contentType).toBe("application/pdf");
    expect(tables.media_uploads[0]).toMatchObject({ mime_type: "application/pdf", width: null, height: null });
  });

  it("still refuses a file type that is not allowed", async () => {
    detect.result = { mime: "application/zip", ext: "zip" };
    const r = await request(app()).post("/media/upload").attach("file", Buffer.from("PK"), "x.zip");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/PDF document/);
    expect(uploads.calls).toHaveLength(0);
  });

  it("the PDF size cap is LinkedIn's 100MB", () => {
    expect(PDF_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});
