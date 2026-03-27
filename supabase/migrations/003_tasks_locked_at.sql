-- Detectar tareas colgadas en "running" si el worker muere a mitad de ejecución
alter table public.tasks add column if not exists locked_at timestamptz;

comment on column public.tasks.locked_at is 'Marca temporal al pasar a running; el worker reencola si queda obsoleta (TASK_STALE_RUNNING_MINUTES)';
