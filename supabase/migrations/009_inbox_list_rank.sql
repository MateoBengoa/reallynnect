-- Orden de la lista como en LinkedIn (0 = conversación más reciente arriba)
alter table public.inbox_conversations
  add column if not exists list_rank bigint;

create index if not exists idx_inbox_conv_account_list_rank
  on public.inbox_conversations (account_id, list_rank asc nulls last);

comment on column public.inbox_conversations.list_rank is 'Posición en la lista de LinkedIn al sincronizar (menor = más reciente)';
