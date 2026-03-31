-- Olas B/C/D: perfiles (webhooks), cuentas (presupuestos/rotación), posts (URN/URL),
-- leads (origen/notas/enriquecimiento), reglas comentario (cuenta/post/DM), log inbound.

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
