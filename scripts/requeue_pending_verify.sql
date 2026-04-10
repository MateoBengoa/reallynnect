-- Ejecutar en Supabase → SQL Editor si verify_session queda en pending y el worker ya está bien configurado.
-- Fuerza scheduled_at a "ahora" para que el poll del worker la vea como due (útil si la fila quedó con fecha antigua).

update public.tasks
set scheduled_at = now()
where status = 'pending'
  and action in ('verify_session', 'session_check');

-- Comprobar:
-- select id, action, status, scheduled_at, attempts, error_message from public.tasks where status = 'pending';
