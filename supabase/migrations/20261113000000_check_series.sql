-- ================================================================
-- Serie giornaliera delle pratiche controllate (grafico a linee
-- della dashboard): una riga per giorno / collega / utente / stato.
-- Rispetta la RLS di practice_checks (SECURITY INVOKER). Idempotente.
-- ================================================================
CREATE OR REPLACE FUNCTION public.check_series(p_days INT DEFAULT 7)
RETURNS TABLE (
  check_day    DATE,
  colleague_id TEXT,
  user_id      UUID,
  status       TEXT,
  n            BIGINT
)
LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT c.check_day, c.colleague_id, c.user_id, c.status, COUNT(*)
  FROM public.practice_checks c
  WHERE c.check_day > (NOW() AT TIME ZONE 'Europe/Rome')::DATE - GREATEST(LEAST(COALESCE(p_days, 7), 366), 1)
  GROUP BY c.check_day, c.colleague_id, c.user_id, c.status;
$$;
REVOKE ALL ON FUNCTION public.check_series(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_series(INT) TO authenticated;
