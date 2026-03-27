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
