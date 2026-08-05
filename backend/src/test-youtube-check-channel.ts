import "dotenv/config";
import { supabase } from "./supabase.js";

async function main() {
  const socialAccountId = process.argv[2];
  const { data: account } = await supabase
    .from("social_accounts")
    .select("access_token_vault_id")
    .eq("id", socialAccountId)
    .single();
  const { data: accessToken } = await supabase.rpc("read_social_token", {
    p_vault_id: account!.access_token_vault_id,
  });
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log(res.status, await res.text());
}
main();
