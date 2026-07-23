-- Internal-only tax/bookkeeping records for IPE Projects (Pty) Ltd, per the
-- user's requirement (2026-07-23): a record of every sale and refund,
-- including the actual payment/payout detail, for SARS purposes. Paddle is
-- LazyRelay's merchant of record and already issues its own tax invoices to
-- end customers directly — this table is NOT a customer-facing invoice, it's
-- IPE Projects' own bookkeeping trail of what Paddle actually sold and paid
-- out. Never emailed to customers (confirmed with the user), only ever read
-- internally/by an accountant.
--
-- One row per Paddle transaction.completed (a "sale") or adjustment.created
-- (a "refund") webhook. A refund row links back to its original sale via
-- paddle_transaction_id, since Paddle's adjustment payload has no customer
-- email of its own to resolve an account from directly.
create table billing_records (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid references accounts(id) on delete set null, -- kept even if the account is later deleted — this is a tax record, not account data
  kind text not null check (kind in ('sale', 'refund')),
  paddle_transaction_id text not null,
  paddle_adjustment_id text, -- set only for kind = 'refund'
  paddle_subscription_id text,
  invoice_number text, -- Paddle's own invoice number, set only for kind = 'sale'
  reason text, -- refund reason, set only for kind = 'refund'
  currency_code text not null,
  subtotal numeric not null,
  tax numeric not null,
  total numeric not null,
  grand_total numeric, -- sale only (total + any credit-to-balance adjustment)
  payout_currency_code text, -- what Paddle actually settles to IPE Projects in — the real payment record for SARS
  payout_subtotal numeric,
  payout_tax numeric,
  payout_fee numeric, -- Paddle's fee, deducted before payout
  payout_earnings numeric, -- the actual net amount paid to IPE Projects for this transaction
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Enable RLS with no policies — locked to service-role access only. This is
-- an internal tax record, never read directly by an authenticated customer
-- (unlike social_accounts/subscriptions, which have their own select-own
-- policies for the account owner).
alter table billing_records enable row level security;

create index billing_records_account_id_idx on billing_records(account_id);
create index billing_records_paddle_transaction_id_idx on billing_records(paddle_transaction_id);
