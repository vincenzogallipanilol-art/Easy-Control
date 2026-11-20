-- ================================================================
-- EASY CONTROL · Registro pratiche gia' controllate su Sally (solo Admin)
--  Le pratiche degli agenti migrati su Sally non vengono aggiornate su EGG: dopo il controllo
--  su Sally ricomparirebbero nei report successivi. Qui si ricordano gli ID: al caricamento di
--  un nuovo report vengono escluse.
--  - sally_checked : una riga per pratica (leggibile/modificabile solo da Admin)
--  - sally_sync    : copia nel registro le pratiche con stato Conforme/Richiesta integrazioni
--                    lavorate dal collega a cui e' agganciato l'agente Sally
-- Idempotente: puo' essere rieseguita senza errori.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.sally_checked (
  pratica_id       TEXT PRIMARY KEY,
  agente           TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '',
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_by       UUID,
  checked_by_name  TEXT NOT NULL DEFAULT '',
  colleague_id     TEXT,
  source           TEXT NOT NULL DEFAULT 'auto',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sally_checked_checked_at_idx ON public.sally_checked (checked_at DESC);

ALTER TABLE public.sally_checked ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sally_checked_admin" ON public.sally_checked;
CREATE POLICY "sally_checked_admin" ON public.sally_checked FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sally_checked TO authenticated;

CREATE OR REPLACE FUNCTION public.sally_sync(p_agents TEXT[], p_colleagues TEXT[])
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorizzato';
  END IF;

  WITH src AS (
    SELECT DISTINCT ON (w.pratica_id)
      w.pratica_id,
      COALESCE(w.agente_attuale, '') AS agente,
      w.status,
      w.set_at,
      w.set_by,
      COALESCE(NULLIF(BTRIM(pr.full_name), ''), pr.email, '') AS by_name,
      w.colleague_id
    FROM public.practice_work w
    JOIN unnest(p_agents, p_colleagues) AS t(agent, col)
      ON lower(btrim(w.agente_attuale)) = t.agent AND w.colleague_id = t.col
    LEFT JOIN public.profiles pr ON pr.id = w.set_by
    WHERE w.status IN ('conforme', 'integrazioni')
    ORDER BY w.pratica_id, w.set_at DESC
  ), up AS (
    INSERT INTO public.sally_checked AS s
      (pratica_id, agente, status, checked_at, checked_by, checked_by_name, colleague_id, source)
    SELECT pratica_id, agente, status, set_at, set_by, by_name, colleague_id, 'auto' FROM src
    ON CONFLICT (pratica_id) DO UPDATE SET
      agente = EXCLUDED.agente, status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
      checked_by = EXCLUDED.checked_by, checked_by_name = EXCLUDED.checked_by_name,
      colleague_id = EXCLUDED.colleague_id
    WHERE s.source = 'auto' AND s.checked_at < EXCLUDED.checked_at
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_n FROM up;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.sally_sync(TEXT[], TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sally_sync(TEXT[], TEXT[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
