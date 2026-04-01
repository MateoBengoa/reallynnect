-- Permite proxies del pool de la app (user_id NULL)
-- El índice anterior era (user_id, webshare_proxy_id) pero no cubre el caso user_id IS NULL

-- Reemplazar el unique index para deduplicar proxies Webshare de la app (user_id NULL)
drop index if exists idx_proxies_webshare_user;

-- Proxies de usuario: único por (user_id, webshare_proxy_id)
create unique index if not exists idx_proxies_webshare_user
  on public.proxies (user_id, webshare_proxy_id)
  where webshare_proxy_id is not null and user_id is not null;

-- Proxies de la app (user_id NULL): único por webshare_proxy_id
create unique index if not exists idx_proxies_webshare_app
  on public.proxies (webshare_proxy_id)
  where webshare_proxy_id is not null and user_id is null;

-- RLS: usuarios ven solo sus propios proxies (user_id = auth.uid())
-- Los proxies de la app (user_id NULL) son invisibles para usuarios — solo el service role los gestiona
drop policy if exists "proxies_own" on public.proxies;
create policy "proxies_own" on public.proxies
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
