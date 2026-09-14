import fs from "node:fs";
import { deleteDisposableAccount } from "./fixtures/backendAdmin.js";
import { ACCOUNT_INFO_PATH } from "./global-setup.js";

// Deletes the one disposable account global-setup created — cascades to
// every social_accounts/scheduled_posts row any spec seeded, so nothing
// else needs cleaning up individually.
export default async function globalTeardown() {
  if (!fs.existsSync(ACCOUNT_INFO_PATH)) return;
  const { accountId, email } = JSON.parse(fs.readFileSync(ACCOUNT_INFO_PATH, "utf-8"));
  await deleteDisposableAccount(accountId);
  fs.rmSync(ACCOUNT_INFO_PATH, { force: true });
  console.log(`[e2e teardown] removed fixture account: ${email} (${accountId})`);
}
