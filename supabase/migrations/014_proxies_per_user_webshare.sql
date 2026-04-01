-- Proxies: propiedad por usuario y asignación 1:1 a cuenta LinkedIn
alter table public.proxies
  add column if not exists user_id uuid references public.profiles (id) on delete cascade,
  add column if not exists account_id uuid references public.linkedin_accounts (id) on delete set null,
  add column if not exists webshare_proxy_id text;

-- Índices de búsqueda
create index if not exists idx_proxies_user on public.proxies (user_id);
create index if not exists idx_proxies_account on public.proxies (account_id);
create unique index if not exists idx_proxies_webshare_user on public.proxies (user_id, webshare_proxy_id)
  where webshare_proxy_id is not null;

-- Garantiza 1:1: un proxy solo puede estar asignado a una cuenta
create unique index if not exists idx_proxies_account_unique on public.proxies (account_id)
  where account_id is not null;

-- RLS: cada usuario ve y gestiona solo sus propios proxies
alter table public.proxies enable row level security;
drop policy if exists "proxies_all" on public.proxies;
drop policy if exists "proxies_own" on public.proxies;
create policy "proxies_own" on public.proxies
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Webshare API key cifrada en el perfil del usuario
alter table public.profiles
  add column if not exists webshare_api_key_encrypted text;

comment on column public.proxies.account_id is 'Si no es null, este proxy está dedicado exclusivamente a esta cuenta LinkedIn';
comment on column public.proxies.webshare_proxy_id is 'ID externo en la API de Webshare.io para dedup en sync';
comment on column public.profiles.webshare_api_key_encrypted is 'API key de Webshare.io cifrada con encryptSecret()';
