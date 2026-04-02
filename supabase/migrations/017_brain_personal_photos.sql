-- Ampliar brain_context para marca personal + fotos
alter table brain_context
  add column if not exists brand_type    text not null default 'company',
  add column if not exists full_name     text not null default '',
  add column if not exists personal_role text not null default '',
  add column if not exists personal_story text not null default '';

-- Fotos del cerebro (marca personal / empresa)
create table if not exists brain_photos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  url           text not null,
  storage_path  text not null,
  label         text not null default '',
  created_at    timestamptz not null default now()
);

alter table brain_photos enable row level security;
create policy "owner" on brain_photos
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());
