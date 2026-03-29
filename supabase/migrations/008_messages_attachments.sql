-- Adjuntos en hilos de mensajería (PDF, Office, etc.) sincronizados desde LinkedIn
alter table public.messages
  add column if not exists attachments jsonb;

comment on column public.messages.attachments is 'Array JSON: [{ "name": "file.pdf", "kind": "pdf" }]';
