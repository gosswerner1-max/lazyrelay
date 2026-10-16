// Two-way WhatsApp: the inbox, a thread, free-form replies, templates, approval requests, list messages, starting a chat with a saved
// contact, the approvals view, and saved audiences with short update lines.
//
//   GET  /whatsapp/conversations                         the inbox (newest first; the 24 hour window state per conversation)
//   GET  /whatsapp/conversations/:id                     a thread, decrypted for the signed-in customer
//   POST /whatsapp/conversations/:id/read                clear the unread count
//   POST /whatsapp/conversations/:id/reply               free-form text (only inside Meta's 24 hour window)
//   POST /whatsapp/conversations/:id/template            an approved template (any time; saved, opted-in contacts only)
//   POST /whatsapp/conversations/:id/approval            reply buttons (inside the window) or a template (outside it)
//   POST /whatsapp/conversations/:id/list                a list message (inside the window)
//   POST /whatsapp/contacts/:id/conversation             open a chat with a saved, opted-in contact
//   GET  /whatsapp/approvals                             approval requests: pending / approved / changes requested / question
//   GET/POST /whatsapp/audiences, DELETE, members, POST .../send-update   saved audiences and update lines
//
// Gate (whatsappRouteGate.ts): three flags exactly "true", platform visible, a signed-in HUMAN (an API key is refused on EVERY route,
// reads included), a paid plan. Every send goes through chatSend.ts, which applies the same gates as a broadcast and uses ONLY the
// customer's own stored login. A phone number is never returned or logged: people are shown by a mask and the name they gave WhatsApp.
// Approvals are a convenience record, not legal consent.

import express, { type Response, type Router } from "express";
import { z } from "zod";
import { type AuthedRequest } from "../auth.js";
import { dbError } from "./shared.js";
import { fetchHttpClient, type HttpClient } from "../../whatsappBroadcast/cloudApi.js";
import { addAudienceMembers, createAudience, deleteAudience, getThread, listApprovals, listAudiences, listConversations, markRead, removeAudienceMember, sendUpdateToAudience, startConversation } from "../../whatsappChat/conversations.js";
import { sendApprovalRequest, sendChatList, sendChatTemplate, sendChatText, type ChatSendOutcome } from "../../whatsappChat/chatSend.js";
import { UUID, firstIssue, humanRoute, statusForRefusal, userIdFromToken } from "./whatsappRouteGate.js";

/** Plain wording kept with the approvals list so no screen can present a button tap as more than it is. */
export const APPROVAL_NOTE = "An approval is a convenience record of what your client tapped in WhatsApp. It is not legal consent, a signature or proof of a contract.";

const listQuery = z.object({ social_account_id: UUID.optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().datetime({ offset: true }).optional() });
const threadQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), before: z.string().datetime({ offset: true }).optional() });
const replySchema = z.object({ text: z.string().max(10000) });
const templateSchema = z.object({ template_id: UUID, params: z.array(z.string().max(2000)).max(20).default([]) });
const optionSchema = z.object({ id: z.string().max(300), title: z.string().max(100) });
const approvalSchema = z.object({
  title: z.string().max(300),
  body: z.string().max(5000),
  options: z.array(optionSchema).max(10).optional(),
  template_id: UUID.optional(),
  params: z.array(z.string().max(2000)).max(20).optional(),
});
const listMessageSchema = z.object({
  body: z.string().max(10000),
  button_label: z.string().max(100),
  sections: z.array(z.object({ title: z.string().max(100), rows: z.array(z.object({ id: z.string().max(300), title: z.string().max(100), description: z.string().max(200).optional() })).max(20) })).max(20),
});
const approvalsQuery = z.object({ status: z.enum(["pending", "approved", "changes_requested", "question", "other_reply"]).optional(), social_account_id: UUID.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const audienceSchema = z.object({ social_account_id: UUID, name: z.string().max(200) });
const membersSchema = z.object({ contact_ids: z.array(z.string().max(100)).max(500) });
const updateSchema = z.object({ text: z.string().max(10000), template_id: UUID.optional(), params: z.array(z.string().max(2000)).max(20).optional() });

export function buildWhatsAppChatRouter(deps: { http?: HttpClient } = {}): Router {
  const http = deps.http ?? fetchHttpClient;
  const router = express.Router();
  const fail = (res: Response, e: unknown, context: string) => dbError(res, { message: e instanceof Error ? e.message : "unknown error" }, context);
  const sendCtx = (req: AuthedRequest) => ({ accountId: req.accountId!, userId: userIdFromToken(req.rawToken), http });
  const answer = (res: Response, out: ChatSendOutcome) => {
    if (!out.ok) {
      res.status(statusForRefusal(out.code)).json({ error: out.message, code: out.code });
      return;
    }
    res.json({ messageId: out.messageId, status: out.status, mode: out.mode, window: out.window, ...(out.approvalId ? { approvalId: out.approvalId } : {}) });
  };
  const idParam = (req: AuthedRequest, res: Response, name = "id"): string | null => {
    const id = UUID.safeParse(req.params[name]);
    if (!id.success) {
      res.status(400).json({ error: `${name} must be an id` });
      return null;
    }
    return id.data;
  };

  router.get("/whatsapp/conversations", ...humanRoute, async (req: AuthedRequest, res) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "social_account_id must be a connection id; limit 1 to 100; before an ISO time" });
      return;
    }
    try {
      res.json(await listConversations(req.accountId!, { socialAccountId: q.data.social_account_id, limit: q.data.limit, before: q.data.before ? new Date(q.data.before).toISOString() : undefined }));
    } catch (e) {
      fail(res, e, "GET /whatsapp/conversations");
    }
  });

  router.get("/whatsapp/conversations/:id", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const q = threadQuery.safeParse(req.query);
    if (!id) return;
    if (!q.success) {
      res.status(400).json({ error: "limit 1 to 200; before an ISO time" });
      return;
    }
    try {
      const thread = await getThread(req.accountId!, id, { limit: q.data.limit, before: q.data.before ? new Date(q.data.before).toISOString() : undefined });
      if (!thread) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(thread);
    } catch (e) {
      fail(res, e, "GET /whatsapp/conversations/:id");
    }
  });

  router.post("/whatsapp/conversations/:id/read", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    if (!id) return;
    try {
      if (!(await markRead(req.accountId!, id))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, "POST /whatsapp/conversations/:id/read");
    }
  });

  router.post("/whatsapp/conversations/:id/reply", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const b = replySchema.safeParse(req.body ?? {});
    if (!id) return;
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error), code: "text_invalid" });
      return;
    }
    try {
      answer(res, await sendChatText(sendCtx(req), id, b.data.text));
    } catch (e) {
      fail(res, e, "POST /whatsapp/conversations/:id/reply");
    }
  });

  router.post("/whatsapp/conversations/:id/template", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const b = templateSchema.safeParse(req.body ?? {});
    if (!id) return;
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      answer(res, await sendChatTemplate(sendCtx(req), id, b.data.template_id, b.data.params));
    } catch (e) {
      fail(res, e, "POST /whatsapp/conversations/:id/template");
    }
  });

  router.post("/whatsapp/conversations/:id/approval", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const b = approvalSchema.safeParse(req.body ?? {});
    if (!id) return;
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      answer(res, await sendApprovalRequest(sendCtx(req), id, { title: b.data.title, body: b.data.body, options: b.data.options, templateId: b.data.template_id, params: b.data.params }));
    } catch (e) {
      fail(res, e, "POST /whatsapp/conversations/:id/approval");
    }
  });

  router.post("/whatsapp/conversations/:id/list", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const b = listMessageSchema.safeParse(req.body ?? {});
    if (!id) return;
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      answer(res, await sendChatList(sendCtx(req), id, { body: b.data.body, buttonLabel: b.data.button_label, sections: b.data.sections }));
    } catch (e) {
      fail(res, e, "POST /whatsapp/conversations/:id/list");
    }
  });

  router.post("/whatsapp/contacts/:id/conversation", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    if (!id) return;
    try {
      const out = await startConversation(req.accountId!, id);
      if (!out.ok) {
        res.status(statusForRefusal(out.code)).json({ error: out.code === "not_found" ? "Not found" : "That contact cannot be messaged.", code: out.code });
        return;
      }
      res.status(out.created ? 201 : 200).json({ conversationId: out.conversationId, created: out.created, window: { open: false, expiresAt: null, hoursLeft: 0 } });
    } catch (e) {
      fail(res, e, "POST /whatsapp/contacts/:id/conversation");
    }
  });

  router.get("/whatsapp/approvals", ...humanRoute, async (req: AuthedRequest, res) => {
    const q = approvalsQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "status pending, approved, changes_requested, question or other_reply; limit 1 to 100" });
      return;
    }
    try {
      res.json({ ...(await listApprovals(req.accountId!, { status: q.data.status, socialAccountId: q.data.social_account_id, limit: q.data.limit })), note: APPROVAL_NOTE });
    } catch (e) {
      fail(res, e, "GET /whatsapp/approvals");
    }
  });

  router.get("/whatsapp/audiences", ...humanRoute, async (req: AuthedRequest, res) => {
    const q = z.object({ social_account_id: UUID.optional() }).safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "social_account_id must be a connection id" });
      return;
    }
    try {
      res.json({ audiences: await listAudiences(req.accountId!, q.data.social_account_id) });
    } catch (e) {
      fail(res, e, "GET /whatsapp/audiences");
    }
  });

  router.post("/whatsapp/audiences", ...humanRoute, async (req: AuthedRequest, res) => {
    const b = audienceSchema.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      const out = await createAudience(req.accountId!, userIdFromToken(req.rawToken), { socialAccountId: b.data.social_account_id, name: b.data.name });
      if (!out.ok) {
        const message = out.code === "name_taken" ? "You already have an audience with that name." : out.code === "connection_not_found" ? "That WhatsApp connection was not found." : "Give the audience a short name that is not a phone number.";
        res.status(statusForRefusal(out.code)).json({ error: message, code: out.code });
        return;
      }
      res.status(201).json({ id: out.id });
    } catch (e) {
      fail(res, e, "POST /whatsapp/audiences");
    }
  });

  router.delete("/whatsapp/audiences/:id", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    if (!id) return;
    try {
      if (!(await deleteAudience(req.accountId!, id))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, "DELETE /whatsapp/audiences/:id");
    }
  });

  router.post("/whatsapp/audiences/:id/members", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const b = membersSchema.safeParse(req.body ?? {});
    if (!id) return;
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      const out = await addAudienceMembers(req.accountId!, id, b.data.contact_ids);
      if (!out.ok) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ added: out.added, skipped: out.skipped });
    } catch (e) {
      fail(res, e, "POST /whatsapp/audiences/:id/members");
    }
  });

  router.delete("/whatsapp/audiences/:id/members/:contactId", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const contactId = idParam(req, res, "contactId");
    if (!id || !contactId) return;
    try {
      if (!(await removeAudienceMember(req.accountId!, id, contactId))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, "DELETE /whatsapp/audiences/:id/members/:contactId");
    }
  });

  router.post("/whatsapp/audiences/:id/send-update", ...humanRoute, async (req: AuthedRequest, res) => {
    const id = idParam(req, res);
    const b = updateSchema.safeParse(req.body ?? {});
    if (!id) return;
    if (!b.success) {
      res.status(400).json({ error: firstIssue(b.error) });
      return;
    }
    try {
      const out = await sendUpdateToAudience(sendCtx(req), id, { text: b.data.text, templateId: b.data.template_id, params: b.data.params });
      if (!out.ok) {
        res.status(statusForRefusal(out.code)).json({ error: out.message, code: out.code });
        return;
      }
      res.json({ summary: out.summary, results: out.results });
    } catch (e) {
      fail(res, e, "POST /whatsapp/audiences/:id/send-update");
    }
  });

  return router;
}
