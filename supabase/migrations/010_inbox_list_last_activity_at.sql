-- Fecha/hora del último mensaje según la fila de lista de LinkedIn (parseada en sync)
alter table public.inbox_conversations
  add column if not exists list_last_activity_at timestamptz;

create index if not exists idx_inbox_conv_account_list_activity
  on public.inbox_conversations (account_id, list_last_activity_at desc nulls last);

comment on column public.inbox_conversations.list_last_activity_at is 'Última actividad inferida del timestamp visible en la lista de mensajes de LinkedIn';
