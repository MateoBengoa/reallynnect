-- Contexto de negocio por usuario ("Cerebro")
create table if not exists brain_context (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  company_name  text not null default '',
  description   text not null default '',
  products      text not null default '',
  audience      text not null default '',
  tone          text not null default '',
  value_prop    text not null default '',
  keywords      text not null default '',
  extra         text not null default '',
  updated_at    timestamptz not null default now(),
  constraint brain_context_user_id_key unique (user_id)
);

alter table brain_context enable row level security;

create policy "owner" on brain_context
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
