-- Lista de conversaciones (metadatos desde la lista de LinkedIn); mensajes por hilo en `messages` tras sync bajo demanda
create table if not exists public.inbox_conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.linkedin_accounts (id) on delete cascade,
  conversation_id text not null,
  peer_name text,
  peer_photo_url text,
  list_preview text,
  updated_at timestamptz not null default now(),
  unique (account_id, conversation_id)
);

create index if not exists idx_inbox_conv_account on public.inbox_conversations (account_id);
create index if not exists idx_inbox_conv_updated on public.inbox_conversations (account_id, updated_at desc);

alter table public.inbox_conversations enable row level security;

create policy "inbox_conversations_via_account" on public.inbox_conversations
  for all using (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  );

-- Backfill desde mensajes existentes (solo metadatos) para no dejar lista vacía
insert into public.inbox_conversations (account_id, conversation_id, peer_name, peer_photo_url, list_preview, updated_at)
select distinct on (m.account_id, m.conversation_id)
  m.account_id,
  m.conversation_id,
  m.peer_name,
  m.peer_photo_url,
  left(coalesce(m.message_text, ''), 220),
  coalesce(m.created_at, now())
from public.messages m
where not exists (
  select 1 from public.inbox_conversations ic
  where ic.account_id = m.account_id and ic.conversation_id = m.conversation_id
)
order by m.account_id, m.conversation_id, m.created_at desc;
