/** Lightweight ops-alerting hook. Always logs to stderr (Render's own logs
 *  are the baseline fallback); additionally posts to a Slack webhook when
 *  SLACK_WEBHOOK_URL is configured, mirroring the alerting pattern already
 *  used by the email-operations agent (#all-lazyrelay). Nothing here should
 *  ever throw into the caller — a failed alert must not fail the operation
 *  it was alerting about. */
export async function notifyOps(message: string): Promise<void> {
  console.error(`[ops-alert] ${message}`);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `:rotating_light: LazyRelay ops alert: ${message}` }),
    });
  } catch (err) {
    console.error(`Failed to deliver ops alert to Slack: ${err instanceof Error ? err.message : String(err)}`);
  }
}
