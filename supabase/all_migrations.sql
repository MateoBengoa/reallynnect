-- =============================================================================
-- reallynnect — ESQUEMA COMPLETO (una sola ejecución)
-- Proyecto Supabase NUEVO: pega TODO en SQL Editor y ejecuta una vez.
-- No re-ejecutar sobre BD ya migrada (puede fallar en políticas duplicadas).
-- =============================================================================

-- ─── 001_initial_schema.sql ─────────────────────────────────────────────────

-- LinkedIn automation SaaS — schema + RLS
-- Run in Supabase SQL Editor or via supabase db push

-- Profiles (app user mirrors auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- Proxies (pool; assign per linkedin account)
create table if not exists public.proxies (
  id uuid primary key default gen_random_uuid(),
  host text not null,
  port int not null,
  username text,
  password text, -- encrypted at app layer
  status text not null default 'active' check (status in ('active', 'degraded', 'inactive')),
  last_used timestamptz,
  created_at timestamptz not null default now()
);

-- Only service role / backend should manage proxies typically; optional admin RLS omitted — use service role from API

-- LinkedIn accounts
create table if not exists public.linkedin_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  li_at_cookie text not null, -- AES-GCM ciphertext from app
  proxy_id uuid references public.proxies (id),
  warmup_state text not null default 'cold' check (warmup_state in ('cold', 'warming', 'warm')),
  softban_status text not null default 'ok' check (softban_status in ('ok', 'suspected', 'paused')),
  paused_until timestamptz,
  connection_status text not null default 'pending' check (connection_status in ('pending', 'active', 'error')),
  last_warmup_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_linkedin_accounts_user on public.linkedin_accounts (user_id);

alter table public.linkedin_accounts enable row level security;

create policy "linkedin_accounts_crud_own" on public.linkedin_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Leads
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  profile_url text not null,
  name text,
  company text,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists idx_leads_user on public.leads (user_id);

alter table public.leads enable row level security;

create policy "leads_crud_own" on public.leads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Campaigns
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_campaigns_user on public.campaigns (user_id);

alter table public.campaigns enable row level security;

create policy "campaigns_crud_own" on public.campaigns
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Campaign steps
create table if not exists public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  step_order int not null default 0,
  step_type text not null check (step_type in (
    'visit_profile', 'connect', 'send_message', 'follow', 'like_post', 'comment_post'
  )),
  delay_hours int not null default 0,
  message_template text,
  created_at timestamptz not null default now(),
  unique (campaign_id, step_order)
);

create index if not exists idx_campaign_steps_campaign on public.campaign_steps (campaign_id);

alter table public.campaign_steps enable row level security;

create policy "campaign_steps_via_campaign" on public.campaign_steps
  for all using (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  );

-- Enrollments (lead in a campaign)
create table if not exists public.campaign_enrollments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  current_step_index int not null default 0,
  next_run_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  unique (campaign_id, lead_id)
);

create index if not exists idx_enrollments_next on public.campaign_enrollments (next_run_at) where status = 'active';
create index if not exists idx_enrollments_campaign on public.campaign_enrollments (campaign_id);

alter table public.campaign_enrollments enable row level security;

create policy "enrollments_via_campaign" on public.campaign_enrollments
  for all using (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.campaigns c where c.id = campaign_id and c.user_id = auth.uid())
  );

-- Posts (scheduled / AI)
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.linkedin_accounts (id) on delete cascade,
  content text not null,
  image_url text,
  scheduled_time timestamptz,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'published', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_posts_account on public.posts (account_id);
create index if not exists idx_posts_scheduled on public.posts (scheduled_time) where status = 'scheduled';

alter table public.posts enable row level security;

create policy "posts_via_account" on public.posts
  for all using (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  );

-- Keyword rules
create table if not exists public.keyword_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  keyword text not null,
  reply_template text not null,
  rule_type text not null default 'dm' check (rule_type in ('dm', 'comment')),
  use_ai boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_keyword_rules_user on public.keyword_rules (user_id);

alter table public.keyword_rules enable row level security;

create policy "keyword_rules_crud_own" on public.keyword_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Messages log
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.linkedin_accounts (id) on delete cascade,
  conversation_id text not null,
  message_text text,
  direction text not null default 'in' check (direction in ('in', 'out')),
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_account on public.messages (account_id);
create index if not exists idx_messages_conv on public.messages (account_id, conversation_id);

alter table public.messages enable row level security;

create policy "messages_via_account" on public.messages
  for all using (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  );

-- Automation tasks
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.linkedin_accounts (id) on delete cascade,
  action text not null,
  lead_id uuid references public.leads (id) on delete set null,
  enrollment_id uuid references public.campaign_enrollments (id) on delete set null,
  scheduled_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'dead')),
  payload jsonb default '{}',
  attempts int not null default 0,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_tasks_due on public.tasks (scheduled_at, status) where status = 'pending';
create index if not exists idx_tasks_account on public.tasks (account_id);

alter table public.tasks enable row level security;

create policy "tasks_via_account" on public.tasks
  for all using (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.linkedin_accounts a where a.id = account_id and a.user_id = auth.uid())
  );

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Storage: post images (create bucket in Dashboard or below)
insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', false)
on conflict (id) do nothing;

create policy "Users upload own post images"
on storage.objects for insert
with check (
  bucket_id = 'post-images'
  and auth.uid() is not null
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users read own post images"
on storage.objects for select
using (
  bucket_id = 'post-images'
  and auth.uid() is not null
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ─── 002_linkedin_profile_fields.sql ───────────────────────────────────────

alter table public.linkedin_accounts
  add column if not exists li_display_name text,
  add column if not exists li_headline text,
  add column if not exists li_photo_url text,
  add column if not exists session_verified_at timestamptz;

comment on column public.linkedin_accounts.li_display_name is 'Nombre visible en LinkedIn (scraping /in/me)';
comment on column public.linkedin_accounts.li_headline is 'Titular / puesto en LinkedIn';
comment on column public.linkedin_accounts.li_photo_url is 'URL de la foto de perfil (media.licdn.com, etc.)';
comment on column public.linkedin_accounts.session_verified_at is 'Cuándo terminó la última verificación de sesión (tarea verify_session)';

-- ─── 003_tasks_locked_at.sql ───────────────────────────────────────────────

alter table public.tasks add column if not exists locked_at timestamptz;

comment on column public.tasks.locked_at is 'Marca temporal al pasar a running; el worker reencola si queda obsoleta (TASK_STALE_RUNNING_MINUTES)';

-- ─── 004_campaign_step_types_extend.sql ────────────────────────────────────

alter table public.campaign_steps drop constraint if exists campaign_steps_step_type_check;

alter table public.campaign_steps add constraint campaign_steps_step_type_check check (step_type in (
  'visit_profile',
  'connect',
  'send_message',
  'send_message_open_profile',
  'follow',
  'like_post',
  'comment_post',
  'voice_note',
  'reply_comment',
  'inmail'
));

-- ─── 005_inbox_dm_dedupe.sql ───────────────────────────────────────────────

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

-- ─── 006_messages_peer_photo.sql ─────────────────────────────────────────

alter table public.messages
  add column if not exists peer_photo_url text;

-- ─── 007_inbox_conversations.sql ───────────────────────────────────────────

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

-- ─── 008_messages_attachments.sql ────────────────────────────────────────

alter table public.messages
  add column if not exists attachments jsonb;

comment on column public.messages.attachments is 'Array JSON: [{ "name": "file.pdf", "kind": "pdf" }]';

-- ─── 009_inbox_list_rank.sql ───────────────────────────────────────────────

alter table public.inbox_conversations
  add column if not exists list_rank bigint;

create index if not exists idx_inbox_conv_account_list_rank
  on public.inbox_conversations (account_id, list_rank asc nulls last);

comment on column public.inbox_conversations.list_rank is 'Posición en la lista de LinkedIn al sincronizar (menor = más reciente)';

-- ─── 010_inbox_list_last_activity_at.sql ───────────────────────────────────

alter table public.inbox_conversations
  add column if not exists list_last_activity_at timestamptz;

create index if not exists idx_inbox_conv_account_list_activity
  on public.inbox_conversations (account_id, list_last_activity_at desc nulls last);

comment on column public.inbox_conversations.list_last_activity_at is 'Última actividad inferida del timestamp visible en la lista de mensajes de LinkedIn';

-- ─── 011_waves_b_c_d.sql ───────────────────────────────────────────────────

alter table public.profiles
  add column if not exists webhook_url text,
  add column if not exists webhook_events text[];

comment on column public.profiles.webhook_url is 'URL HTTPS para POST de eventos de tareas (opcional)';
comment on column public.profiles.webhook_events is 'Ej. task.completed, task.failed; null = ambos; [] = ninguno';

alter table public.linkedin_accounts
  add column if not exists daily_message_budget int,
  add column if not exists daily_visit_budget int,
  add column if not exists daily_connect_budget int,
  add column if not exists rotation_priority int not null default 0;

comment on column public.linkedin_accounts.rotation_priority is 'Menor número = preferencia al elegir cuenta activa para campañas';

alter table public.posts
  add column if not exists linkedin_activity_url text,
  add column if not exists linkedin_activity_urn text;

alter table public.leads
  add column if not exists source text,
  add column if not exists notes text,
  add column if not exists last_enriched_at timestamptz;

alter table public.keyword_rules
  add column if not exists account_id uuid references public.linkedin_accounts (id) on delete set null,
  add column if not exists post_id uuid references public.posts (id) on delete set null,
  add column if not exists dm_followup_template text,
  add column if not exists dm_followup_use_ai boolean not null default false;

create index if not exists idx_keyword_rules_account on public.keyword_rules (account_id) where account_id is not null;
create index if not exists idx_keyword_rules_post on public.keyword_rules (post_id) where post_id is not null;

create table if not exists public.inbound_comment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  account_id uuid not null references public.linkedin_accounts (id) on delete cascade,
  rule_id uuid not null references public.keyword_rules (id) on delete cascade,
  event_type text not null check (event_type in ('comment_reply', 'dm_followup', 'skip', 'error')),
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_inbound_comment_events_user on public.inbound_comment_events (user_id, created_at desc);

alter table public.inbound_comment_events enable row level security;

create policy "inbound_comment_events_select_own" on public.inbound_comment_events
  for select using (auth.uid() = user_id);

-- ─── 012_campaigns_leads_ux.sql ──────────────────────────────────────────

alter table public.leads
  add column if not exists headline text,
  add column if not exists photo_url text,
  add column if not exists location text,
  add column if not exists website text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists is_blacklisted boolean not null default false,
  add column if not exists duplicate_of uuid references public.leads (id) on delete set null;

create index if not exists idx_leads_user_profile_url on public.leads (user_id, profile_url);

alter table public.campaign_enrollments
  add column if not exists crm_status text not null default 'not_contacted'
    check (crm_status in (
      'not_contacted', 'in_campaign', 'contacted', 'replied', 'not_accepted',
      'blacklist', 'duplicate', 'failed'
    ));

alter table public.campaigns
  add column if not exists skip_contacted_other_campaigns boolean not null default false,
  add column if not exists schedule_json jsonb,
  add column if not exists frequency_limits jsonb,
  add column if not exists workflow_edges jsonb;

alter table public.campaign_steps
  add column if not exists position_x double precision,
  add column if not exists position_y double precision;

alter table public.profiles
  add column if not exists exclude_connect_messages_from_reply_rate boolean not null default false;

create table if not exists public.lead_import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  source_type text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  error text,
  inserted_count int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lead_import_jobs_user on public.lead_import_jobs (user_id);
create index if not exists idx_lead_import_jobs_status on public.lead_import_jobs (status) where status = 'pending';

alter table public.lead_import_jobs enable row level security;

create policy "lead_import_jobs_own" on public.lead_import_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on column public.campaigns.workflow_edges is 'Aristas React Flow [{source,target,sourceHandle,targetHandle}] para persistir grafo';
comment on column public.campaigns.schedule_json is '7 días: [{day,enabled,start,end}] UTC HH:mm';
comment on column public.campaigns.frequency_limits is 'Límites diarios por tipo de acción (JSON)';

-- ─── 012_keyword_rules_is_active.sql ───────────────────────────────────────

alter table public.keyword_rules
  add column if not exists is_active boolean not null default true;

comment on column public.keyword_rules.is_active is 'Si false, el worker no aplica esta regla (DM ni comentarios).';

-- ─── 013_cleanup_duplicate_pending_tasks.sql ─────────────────────────────

DELETE FROM tasks
WHERE status = 'pending'
  AND enrollment_id IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (enrollment_id) id
    FROM tasks
    WHERE status = 'pending'
      AND enrollment_id IS NOT NULL
    ORDER BY enrollment_id, scheduled_at ASC
  );

-- ─── 014_proxies_per_user_webshare.sql ────────────────────────────────────

alter table public.proxies
  add column if not exists user_id uuid references public.profiles (id) on delete cascade,
  add column if not exists account_id uuid references public.linkedin_accounts (id) on delete set null,
  add column if not exists webshare_proxy_id text;

create index if not exists idx_proxies_user on public.proxies (user_id);
create index if not exists idx_proxies_account on public.proxies (account_id);
create unique index if not exists idx_proxies_webshare_user on public.proxies (user_id, webshare_proxy_id)
  where webshare_proxy_id is not null;

create unique index if not exists idx_proxies_account_unique on public.proxies (account_id)
  where account_id is not null;

alter table public.proxies enable row level security;
drop policy if exists "proxies_all" on public.proxies;
drop policy if exists "proxies_own" on public.proxies;
create policy "proxies_own" on public.proxies
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.profiles
  add column if not exists webshare_api_key_encrypted text;

comment on column public.proxies.account_id is 'Si no es null, este proxy está dedicado exclusivamente a esta cuenta LinkedIn';
comment on column public.proxies.webshare_proxy_id is 'ID externo en la API de Webshare.io para dedup en sync';
comment on column public.profiles.webshare_api_key_encrypted is 'API key de Webshare.io cifrada con encryptSecret()';

-- ─── 015_proxies_app_pool.sql ────────────────────────────────────────────

drop index if exists idx_proxies_webshare_user;

create unique index if not exists idx_proxies_webshare_user
  on public.proxies (user_id, webshare_proxy_id)
  where webshare_proxy_id is not null and user_id is not null;

create unique index if not exists idx_proxies_webshare_app
  on public.proxies (webshare_proxy_id)
  where webshare_proxy_id is not null and user_id is null;

drop policy if exists "proxies_own" on public.proxies;
create policy "proxies_own" on public.proxies
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── 016_brain_context.sql ────────────────────────────────────────────────

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

-- ─── 017_brain_personal_photos.sql ─────────────────────────────────────────

alter table brain_context
  add column if not exists brand_type    text not null default 'company',
  add column if not exists full_name     text not null default '',
  add column if not exists personal_role text not null default '',
  add column if not exists personal_story text not null default '';

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

-- ─── 018_posts_suggested_photo_context.sql ───────────────────────────────

alter table public.posts
  add column if not exists suggested_photo_context text;

comment on column public.posts.suggested_photo_context is
  'Descripción de la foto real del cerebro que la IA sugiere usar para este post. Null = usar imagen generada.';

-- ─── 019_messages_event_urn.sql ──────────────────────────────────────────────
-- Columna para el URN único de LinkedIn por mensaje (contiene timestamp real).
alter table public.messages
  add column if not exists event_urn text;

-- Índice único: permite upsert estable por URN (solo para filas con URN).
create unique index if not exists idx_messages_event_urn
  on public.messages (account_id, event_urn)
  where event_urn is not null;

-- ─── 020_reset_message_timestamps.sql ───────────────────────────────────────
-- Limpia todos los mensajes para que el próximo sync re-inserte con
-- timestamps reales capturados desde la API Voyager de LinkedIn.
-- Ejecutar una sola vez en el SQL Editor de Supabase.
delete from public.messages;

-- =============================================================================
-- Fin. Activa Email en Auth y configura SUPABASE_* en backend + frontend.
-- =============================================================================
