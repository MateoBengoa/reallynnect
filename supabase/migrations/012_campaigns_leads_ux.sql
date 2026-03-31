-- Leads: perfil enriquecido + blacklist
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

-- Enrollments: estado CRM (UI) separado del status operativo del motor
alter table public.campaign_enrollments
  add column if not exists crm_status text not null default 'not_contacted'
    check (crm_status in (
      'not_contacted', 'in_campaign', 'contacted', 'replied', 'not_accepted',
      'blacklist', 'duplicate', 'failed'
    ));

-- Campañas: ajustes motor + grafo (aristas opcionales JSON)
alter table public.campaigns
  add column if not exists skip_contacted_other_campaigns boolean not null default false,
  add column if not exists schedule_json jsonb,
  add column if not exists frequency_limits jsonb,
  add column if not exists workflow_edges jsonb;

-- Pasos: posición en canvas n8n
alter table public.campaign_steps
  add column if not exists position_x double precision,
  add column if not exists position_y double precision;

-- Perfil: preferencia global reply rate
alter table public.profiles
  add column if not exists exclude_connect_messages_from_reply_rate boolean not null default false;

-- Jobs de importación (worker asíncrono)
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
