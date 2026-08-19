import "dotenv/config";
import { supabase } from "./supabase.js";
import { createClient } from "@supabase/supabase-js";

// One-off manual smoke test — proves the real media upload endpoint works
// end to end: real user, real session, real multipart upload to the live
// deployed API, real Supabase Storage object, real publicly-fetchable URL.
const API_URL = "https://lazyrelaylazyrelay-backend.onrender.com/api";
const SUPABASE_URL = process.env.SUPABASE_URL!;
// Public anon key (safe to embed — same value as frontend/.env.production's
// VITE_SUPABASE_ANON_KEY), needed here only to mint a real user session via
// signInWithPassword rather than the service-role key this script otherwise
// uses. Read from env rather than hardcoded, so this file has no reason to
// be flagged by a future secrets scan just for containing a key-shaped string.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
if (!SUPABASE_ANON_KEY) throw new Error("SUPABASE_ANON_KEY is required in backend/.env to run this script");

// A minimal valid 1x1 red PNG, hardcoded as base64 — no need to generate a
// real image file for this test, just needs to be bytes multer/Supabase
// Storage will actually accept and store.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function main() {
  const email = `media-upload-test-${Date.now()}@lazyrelay.invalid`;
  const password = "test-password-not-real-123";

  const { data: user, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;
  console.log(`Created test user ${email} (${accountId})`);

  try {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    if (signInError || !session.session) throw signInError ?? new Error("no session returned");
    const accessToken = session.session.access_token;

    const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const formData = new FormData();
    formData.append("file", new Blob([pngBytes], { type: "image/png" }), "test.png");

    const uploadRes = await fetch(`${API_URL}/media/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });
    const uploadBody = await uploadRes.json();
    console.log(`Upload response: HTTP ${uploadRes.status}`, uploadBody);
    if (uploadRes.status !== 201 || !uploadBody.url) throw new Error("Upload did not return a URL");

    const fetchRes = await fetch(uploadBody.url);
    console.log(`Fetching public URL: HTTP ${fetchRes.status}, content-type: ${fetchRes.headers.get("content-type")}`);
    const fetchedBytes = Buffer.from(await fetchRes.arrayBuffer());
    const bytesMatch = fetchedBytes.equals(pngBytes);

    console.log("\n--- RESULT ---");
    console.log("Upload returned 201 with a URL:", uploadRes.status === 201 && !!uploadBody.url);
    console.log("Public URL is fetchable (200):", fetchRes.status === 200);
    console.log("Fetched bytes match uploaded bytes:", bytesMatch);
    console.log(uploadRes.status === 201 && fetchRes.status === 200 && bytesMatch ? "PASS" : "FAIL");

    // Also confirm rejection of a bad mime type, using a plain text "file".
    const badFormData = new FormData();
    badFormData.append("file", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "note.txt");
    const badRes = await fetch(`${API_URL}/media/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: badFormData,
    });
    const badBody = await badRes.json();
    console.log(`\nRejected bad mime type: HTTP ${badRes.status}`, badBody);
    console.log(badRes.status === 400 ? "PASS (rejected as expected)" : "FAIL (should have rejected)");
  } finally {
    await supabase.auth.admin.deleteUser(accountId);
    console.log(`\nCleaned up test user ${accountId}`);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
