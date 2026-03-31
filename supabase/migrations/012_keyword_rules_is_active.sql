-- Permitir pausar reglas sin borrarlas (worker solo aplica is_active = true).

alter table public.keyword_rules
  add column if not exists is_active boolean not null default true;

comment on column public.keyword_rules.is_active is 'Si false, el worker no aplica esta regla (DM ni comentarios).';
