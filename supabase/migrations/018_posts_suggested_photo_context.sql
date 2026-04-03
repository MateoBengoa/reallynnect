-- Contexto de foto sugerida por la IA al generar un post
alter table public.posts
  add column if not exists suggested_photo_context text;

comment on column public.posts.suggested_photo_context is
  'Descripción de la foto real del cerebro que la IA sugiere usar para este post. Null = usar imagen generada.';
