import "dotenv/config";
import { supabase } from "./supabase.js";

// One-off: create a board in Pinterest's Sandbox environment (separate from
// production — Trial-access apps must use api-sandbox.pinterest.com) so the
// sandbox test's Pin creation has somewhere to post to (POST /v5/pins
// requires an existing board_id).
async function main() {
  const socialAccountId = process.argv[2];
  if (!socialAccountId) throw new Error("usage: test-pinterest-create-board.ts <socialAccountId>");

  const { data: account, error } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id")
    .eq("id", socialAccountId)
    .single();
  if (error || !account) throw error ?? new Error("social account not found");

  const { data: accessToken, error: readError } = await supabase.rpc("read_social_token", {
    p_vault_id: account.access_token_vault_id,
  });
  if (readError) throw readError;

  const res = await fetch("https://api-sandbox.pinterest.com/v5/boards", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "LazyRelay Test Board",
      description: "Board used for LazyRelay Pinterest adapter end-to-end testing",
    }),
  });
  const json = await res.json();
  console.log("Board creation result:", res.status, json);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
