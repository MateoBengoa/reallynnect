-- Elimina tasks pending duplicadas por enrollment: conserva solo la más próxima (scheduled_at ASC).
-- Causa: scheduleEnrollmentStep no tenía guard contra ejecuciones concurrentes/re-trigger.
DELETE FROM tasks
WHERE status = 'pending'
  AND enrollment_id IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (enrollment_id) id
    FROM tasks
    WHERE status = 'pending'
      AND enrollment_id IS NOT NULL
    ORDER BY enrollment_id, scheduled_at ASC
  );
