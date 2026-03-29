-- Foto del interlocutor en inbox (última sync por hilo)
alter table public.messages
  add column if not exists peer_photo_url text;
