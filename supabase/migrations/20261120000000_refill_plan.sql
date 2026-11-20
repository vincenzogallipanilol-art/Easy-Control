-- ================================================================
-- EASY CONTROL · "Richiedi altre pratiche" (piano di lavoro finito)
--
--  - pool_candidates : pratiche non assegnate del report, filtrate per tipologia/agenti del collega
--                      (un utente semplice non puo' leggerle: assignments/practices hanno RLS)
--  - claim_practices : assegna al collega le pratiche scelte SOLO se ancora libere (nessuna sovrascrittura)
-- Idempotente: puo' essere rieseguita senza errori.
-- ================================================================

CREATE OR REPLACE FUNCTION public.pool_candidates(
  p_report_id UUID,
  p_tipologie TEXT[],
  p_agents    TEXT[] DEFAULT '{}',
  p_from      INT    DEFAULT 0,
  p_to        INT    DEFAULT 999
) RETURNS SETOF public.practices
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.*
  FROM public.practices p
  WHERE public.is_approved()
    AND p.report_id = p_report_id
    AND (
      lower(btrim(p.tipologia)) = ANY (p_tipologie)
      OR lower(btrim(p.agente_attuale)) = ANY (p_agents)
    )
    AND NOT EXISTS (SELECT 1 FROM public.assignments a WHERE a.practice_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.practices p2 JOIN public.assignments a2 ON a2.practice_id = p2.id
      WHERE p2.report_id = p.report_id AND p2.pratica_id = p.pratica_id AND p.pratica_id <> ''
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.practice_work w
      WHERE w.pratica_id = p.pratica_id AND w.closed_at IS NULL
        AND w.status IN ('da_chiamare', 'audit', 'help', 'xflat')
    )
  ORDER BY p.id
  OFFSET GREATEST(p_from, 0) LIMIT GREATEST(p_to - p_from + 1, 0);
$$;

CREATE OR REPLACE FUNCTION public.claim_practices(
  p_colleague_id TEXT,
  p_report_id    UUID,
  p_practice_ids UUID[]
) RETURNS SETOF public.assignments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_approved() THEN
    RAISE EXCEPTION 'Non autorizzato';
  END IF;
  -- un utente semplice puo' prendere pratiche solo per il proprio collega
  IF NOT public.can_see_all()
     AND p_colleague_id IS DISTINCT FROM (SELECT colleague_id FROM public.profiles WHERE id = auth.uid()) THEN
    RAISE EXCEPTION 'Non autorizzato su questo piano di lavoro';
  END IF;

  RETURN QUERY
  INSERT INTO public.assignments (practice_id, report_id, colleague_id, is_manual, assigned_by, assigned_at)
  SELECT p.id, p.report_id, p_colleague_id, FALSE, auth.uid(), NOW()
  FROM public.practices p
  WHERE p.id = ANY (p_practice_ids) AND p.report_id = p_report_id
    AND NOT EXISTS (
      SELECT 1 FROM public.practices p2 JOIN public.assignments a2 ON a2.practice_id = p2.id
      WHERE p2.report_id = p.report_id AND p2.pratica_id = p.pratica_id AND p.pratica_id <> ''
    )
  ON CONFLICT (practice_id) DO NOTHING
  RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pool_candidates(UUID, TEXT[], TEXT[], INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_practices(TEXT, UUID, UUID[])             TO authenticated;
