-- Perfil del miembro logueado (tras verificar sesión) + marca de verificación completada
alter table public.linkedin_accounts
  add column if not exists li_display_name text,
  add column if not exists li_headline text,
  add column if not exists li_photo_url text,
  add column if not exists session_verified_at timestamptz;

comment on column public.linkedin_accounts.li_display_name is 'Nombre visible en LinkedIn (scraping /in/me)';
comment on column public.linkedin_accounts.li_headline is 'Titular / puesto en LinkedIn';
comment on column public.linkedin_accounts.li_photo_url is 'URL de la foto de perfil (media.licdn.com, etc.)';
comment on column public.linkedin_accounts.session_verified_at is 'Cuándo terminó la última verificación de sesión (tarea verify_session)';
