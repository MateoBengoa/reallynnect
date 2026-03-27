-- Inbox / DM autoreply dedupe + optional peer display name
alter table public.messages
  add column if not exists peer_name text,
  add column if not exists rule_id uuid references public.keyword_rules (id) on delete set null;

create table if not exists public.dm_autoreply_sent (
  account_id uuid not null references public.linkedin_accounts (id) on delete cascade,
  conversation_id text not null,
  rule_id uuid not null references public.keyword_rules (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, conversation_id, rule_id)
);

create index if not exists idx_dm_autoreply_account on public.dm_autoreply_sent (account_id);

alter table public.dm_autoreply_sent enable row level security;

create policy "dm_autoreply_via_account" on public.dm_autoreply_sent
  for all using (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  );
