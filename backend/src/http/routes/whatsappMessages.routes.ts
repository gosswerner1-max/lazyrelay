// Reading the inbound WhatsApp messages the webhook stored (table whatsapp_messages, migration 0127), newest first, for
// one WhatsApp connection and optionally one contact thread.
//
//   - Signed in (requireAuth) and only while the WhatsApp feature is on (WHATSAPP_BYOK_ENABLED); otherwise a 404, like
//     the webhook itself.
//   - Reads through req.db, the caller's own database role, so the row level security policy (members of the owning
//     account only) applies on top of the explicit account_id filter below: two independent walls.
//   - A phone number is never in the table and never in the answer: a thread is identified by contactKey (a keyed hash),
//     and contactDisplay is a mask such as "+27 ** *** 1111".
//   - Paging: limit (1 to 100, default 50) and before (an ISO time; only messages received earlier), newest first.

import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../auth.js";
import { tieredRateLimit } from "../rateLimit.js";
import { dbError } from "./shared.js";

const querySchema = z.object({
  social_account_id: z.string().uuid(),
  contact_key: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

export const WHATSAPP_MESSAGE_COLUMNS = "id, wamid, contact_key, contact_display, contact_name, text, received_at, triage_category, needs_attention, triage_reason, triaged_at";

interface MessageRow {
  id: string;
  wamid: string;
  contact_key: string;
  contact_display: string | null;
  contact_name: string | null;
  text: string;
  received_at: string;
  triage_category: string | null;
  needs_attention: boolean | null;
  triage_reason: string | null;
  triaged_at: string | null;
}

export function buildWhatsAppMessagesRouter(): Router {
  const router = Router();

  router.get("/whatsapp/messages", requireAuth, tieredRateLimit, async (req: AuthedRequest, res) => {
    if (process.env.WHATSAPP_BYOK_ENABLED !== "true") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "social_account_id must be a connection id; contact_key (optional) a thread key; limit 1 to 100; before an ISO time" });
      return;
    }
    const { social_account_id, contact_key, limit, before } = parsed.data;

    let query = req
      .db!.from("whatsapp_messages")
      .select(WHATSAPP_MESSAGE_COLUMNS)
      .eq("account_id", req.accountId!)
      .eq("social_account_id", social_account_id);
    if (contact_key) query = query.eq("contact_key", contact_key);
    if (before) query = query.lt("received_at", new Date(before).toISOString());
    const { data, error } = await query.order("received_at", { ascending: false }).limit(limit);
    if (error) {
      dbError(res, error, "GET /whatsapp/messages");
      return;
    }

    const rows = (data ?? []) as unknown as MessageRow[];
    res.json({
      messages: rows.map((r) => ({
        id: r.id,
        wamid: r.wamid,
        contactKey: r.contact_key,
        contactDisplay: r.contact_display,
        contactName: r.contact_name,
        text: r.text,
        receivedAt: r.received_at,
        triageCategory: r.triage_category,
        needsAttention: r.needs_attention,
        triageReason: r.triage_reason,
        triagedAt: r.triaged_at,
      })),
      // Pass this as `before` to read the next (older) page; null when this page was not full.
      nextBefore: rows.length === limit ? rows[rows.length - 1].received_at : null,
    });
  });

  return router;
}
