-- 0133: allow the consent source "direct_entry" (the customer typed a number into "Start a conversation" in the dashboard).
--
-- The system writes that record itself (backend/src/whatsappChat/directEntry.ts): source direct_entry, captured_at = the moment of the
-- click, consent_text = the sentence shown under the input, a separate attestation_version. Nobody states a date the contact consented, so
-- captured_at is the sender's own confirmation time, and the source label says so.
--
-- Additive only: it widens the allowed values of one CHECK constraint on whatsapp_opt_ins. No row is read, changed or deleted (the
-- append-only triggers fire on row changes, not on this). Existing rows already satisfy the wider check.
--
-- ROLLBACK (only while no direct_entry row exists): re-run 0128's constraint line without 'direct_entry'.

begin;

alter table whatsapp_opt_ins drop constraint if exists whatsapp_opt_ins_source_check;
alter table whatsapp_opt_ins add constraint whatsapp_opt_ins_source_check
  check (source in ('customer_import', 'website_form', 'whatsapp_inbound', 'click_to_whatsapp_ad', 'in_person', 'phone_call', 'qr_code', 'other', 'direct_entry'));

commit;
