import "dotenv/config";
import { supabase } from "./supabase.js";
import { validateMediaForPlatform } from "./mediaLimits.js";

// One-off smoke test — confirms the media_uploads table (migration 0009)
// actually works end to end: insert real metadata, read it back, run it
// through validateMediaForPlatform exactly like /scheduled-posts does.

async function main() {
  const email = `media-test-${Date.now()}@lazyrelay.invalid`;
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, email_confirm: true });
  if (userError || !user.user) throw userError ?? new Error("no user returned");
  const accountId = user.user.id;

  // handle_new_user() already creates the accounts row — upsert, not insert.
  await supabase.from("accounts").upsert({ id: accountId, email });

  const testUrl = `https://example.invalid/media-test-${Date.now()}.jpg`;
  const { error: insertError } = await supabase.from("media_uploads").insert({
    account_id: accountId,
    url: testUrl,
    mime_type: "image/jpeg",
    size_bytes: 9 * 1024 * 1024, // 9MB — over Instagram's 8MB image limit
    width: 1080,
    height: 1080,
  });
  if (insertError) throw insertError;

  const { data: media, error: readError } = await supabase
    .from("media_uploads")
    .select("mime_type, size_bytes, width, height")
    .eq("url", testUrl)
    .single();
  if (readError || !media) throw readError ?? new Error("no row read back");

  console.log("Read back:", media);

  const result = validateMediaForPlatform("meta", {
    mimeType: media.mime_type,
    sizeBytes: media.size_bytes,
    width: media.width,
    height: media.height,
  });
  console.log("Validation result:", result);

  await supabase.auth.admin.deleteUser(accountId); // cascades to media_uploads via account_id FK

  const pass = result.valid === false && result.reason?.includes("8MB");
  console.log(pass ? "PASS: table + validation wired correctly end to end." : "FAIL");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
