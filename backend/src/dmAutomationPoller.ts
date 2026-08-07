// DM automation — the polling half. Not a server process; run periodically
// by an external scheduled task, same pattern as metricsPoller.ts. Checks
// every active automation for new matching comments and sends a Private
// Reply (not a regular DM — see PlatformAdapter.sendPrivateReply's own
// comment for why the two aren't interchangeable) to whoever left them.
import "dotenv/config";
import { supabase } from "./supabase.js";
import { buildPlatformRegistry } from "./platforms/registry.js";
import { getAccessToken } from "./scheduler.js";
import type { CommentItem } from "./platforms/types.js";

// Meta's own Private Reply eligibility window — a comment older than this
// can no longer be privately replied to, so there's no point even trying.
// Bounds both which comments get attempted and (via TARGET_POST_WINDOW_MS
// below) which posts get scanned at all.
const PRIVATE_REPLY_ELIGIBLE_MS = 7 * 24 * 3600_000;

// For automations with no specific scheduled_post_id (applies to every
// post on the account), scanning literally every post ever made would be
// wasteful and pointless — a comment on a 6-month-old post can't be
// privately replied to anyway once it's past the eligibility window
// above. This is a disclosed limitation, not a silent one: an automation
// aimed at "all posts" only actually covers posts from the last 30 days.
const TARGET_POST_WINDOW_MS = 30 * 24 * 3600_000;

// Real outbound-send cap per run, same reasoning as metricsPoller's
// MAX_POLLS_PER_RUN — this spends the customer's own platform rate-limit
// budget, not LazyRelay's.
const MAX_SENDS_PER_RUN = 50;

interface AutomationRow {
  id: string;
  social_account_id: string;
  scheduled_post_id: string | null;
  keyword: string | null;
  dm_message: string;
  social_accounts: { platform?: string; display_name?: string | null } | { platform?: string; display_name?: string | null }[] | null;
}

function extractSocialAccount(row: AutomationRow): { platform: string | null; displayName: string | null } {
  const sa = Array.isArray(row.social_accounts) ? row.social_accounts[0] : row.social_accounts;
  return { platform: sa?.platform ?? null, displayName: sa?.display_name ?? null };
}

async function getTargetPlatformPostIds(socialAccountId: string, scheduledPostId: string | null): Promise<string[]> {
  let query = supabase
    .from("scheduled_posts")
    .select("id, post_results(platform_post_id, verified_live)")
    .eq("social_account_id", socialAccountId)
    .eq("status", "posted");

  if (scheduledPostId) {
    query = query.eq("id", scheduledPostId);
  } else {
    query = query.gte("scheduled_for", new Date(Date.now() - TARGET_POST_WINDOW_MS).toISOString());
  }

  const { data, error } = await query;
  if (error) {
    console.error("dmAutomationPoller: failed to read scheduled_posts:", error.message);
    return [];
  }

  const ids: string[] = [];
  for (const row of data ?? []) {
    const results = Array.isArray(row.post_results) ? row.post_results : row.post_results ? [row.post_results] : [];
    const live = results.find((r: { verified_live: boolean; platform_post_id: string | null }) => r.verified_live && r.platform_post_id);
    if (live?.platform_post_id) ids.push(live.platform_post_id);
  }
  return ids;
}

async function main() {
  const registry = buildPlatformRegistry();

  const { data: automations, error } = await supabase
    .from("dm_automations")
    .select("id, social_account_id, scheduled_post_id, keyword, dm_message, social_accounts(platform, display_name)")
    .eq("active", true);
  if (error) {
    console.error("dmAutomationPoller: failed to read dm_automations:", error.message);
    process.exit(1);
  }

  if (!automations || automations.length === 0) {
    console.log("dmAutomationPoller: no active automations. Nothing to do.");
    return;
  }

  let commentsScanned = 0;
  let sent = 0;
  let skippedAlreadySent = 0;
  let errored = 0;
  const sendBudget = { remaining: MAX_SENDS_PER_RUN };

  for (const automation of automations as unknown as AutomationRow[]) {
    if (sendBudget.remaining <= 0) break;

    const { platform, displayName } = extractSocialAccount(automation);
    if (!platform) continue;
    const adapter = registry.get(platform);
    if (!adapter?.getComments || !adapter?.sendPrivateReply) continue; // honest "not supported"

    const platformPostIds = await getTargetPlatformPostIds(automation.social_account_id, automation.scheduled_post_id);
    if (platformPostIds.length === 0) continue;

    let accessToken: string;
    try {
      accessToken = await getAccessToken(automation.social_account_id, adapter);
    } catch (err) {
      console.error(`dmAutomationPoller: could not get access token for automation ${automation.id}:`, err instanceof Error ? err.message : err);
      continue;
    }

    const { data: alreadyTriggered } = await supabase
      .from("dm_automation_log")
      .select("comment_id")
      .eq("automation_id", automation.id);
    const triggeredIds = new Set((alreadyTriggered ?? []).map((r) => r.comment_id));

    for (const platformPostId of platformPostIds) {
      if (sendBudget.remaining <= 0) break;

      let comments: CommentItem[];
      try {
        const result = await adapter.getComments(platformPostId, accessToken);
        comments = result.comments;
      } catch (err) {
        console.error(`dmAutomationPoller: getComments failed for automation ${automation.id}:`, err instanceof Error ? err.message : err);
        continue;
      }
      commentsScanned += comments.length;

      for (const comment of comments) {
        if (sendBudget.remaining <= 0) break;
        if (triggeredIds.has(comment.id)) {
          skippedAlreadySent += 1;
          continue;
        }
        if (displayName && comment.author === displayName) continue; // never reply to our own comment
        if (comment.createdAt && Date.now() - new Date(comment.createdAt).getTime() > PRIVATE_REPLY_ELIGIBLE_MS) continue;
        if (automation.keyword && !comment.text.toLowerCase().includes(automation.keyword.toLowerCase())) continue;

        const result = await adapter.sendPrivateReply(comment.id, automation.dm_message, accessToken);
        sendBudget.remaining -= 1;
        if (!result.success) {
          console.error(`dmAutomationPoller: private reply failed for comment ${comment.id}:`, result.errorMessage);
          errored += 1;
          continue; // not logged as triggered — eligible to retry next run
        }

        sent += 1;
        const { error: logError } = await supabase
          .from("dm_automation_log")
          .upsert({ automation_id: automation.id, comment_id: comment.id }, { onConflict: "automation_id,comment_id" });
        if (logError) {
          console.error(`dmAutomationPoller: sent but failed to log comment ${comment.id} (risk of a repeat send next run):`, logError.message);
        }
        triggeredIds.add(comment.id);
      }
    }
  }

  console.log(
    `dmAutomationPoller: ${automations.length} active automations, ${commentsScanned} comments scanned, ${sent} private replies sent, ${skippedAlreadySent} already handled, ${errored} send errors.`
  );
}

main().catch((err) => {
  console.error("dmAutomationPoller: unhandled error:", err);
  process.exit(1);
});
