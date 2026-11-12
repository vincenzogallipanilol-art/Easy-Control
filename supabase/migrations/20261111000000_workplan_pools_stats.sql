-- ================================================================
-- EASY CONTROL · Piano di lavoro, pool di fine giornata, statistiche
--
--  - practice_work   : stato/nota corrente di ogni pratica (per pratica_id)
--  - practice_checks : log giornaliero delle pratiche controllate (conteggi)
--  - colleagues.excluded_agents : agenti esclusi per singolo collega
--
-- Lo smistamento delle ore 19 non ha bisogno di cron: l'app lo ricava da
-- set_at rispetto all'ultimo "19:00 Europe/Rome" gia' passato.
-- Idempotente: puo' essere rieseguita senza errori.
-- ================================================================

-- ── 1. Agenti esclusi per singolo collega ────────────────────────
ALTER TABLE public.colleagues
  ADD COLUMN IF NOT EXISTS excluded_agents TEXT[] DEFAULT '{}';

-- ── 2. Stato di lavorazione corrente della pratica ───────────────
CREATE TABLE IF NOT EXISTS public.practice_work (
  pratica_id           TEXT PRIMARY KEY,
  status               TEXT CHECK (status IN ('conforme','integrazioni','da_chiamare','audit','help','xflat')),
  note                 TEXT NOT NULL DEFAULT '',
  report_id            UUID REFERENCES public.daily_reports(id) ON DELETE SET NULL,
  colleague_id         TEXT REFERENCES public.colleagues(id) ON DELETE SET NULL,
  set_by               UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  set_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- fotografia della pratica (i pool sopravvivono al cambio di report)
  cognome              TEXT DEFAULT '',
  nome                 TEXT DEFAULT '',
  tipologia            TEXT DEFAULT '',
  istituto_finanziario TEXT DEFAULT '',
  agente_attuale       TEXT DEFAULT '',
  -- gestione nei pool (Da chiamare / Audit / xFlat / Help)
  called               BOOLEAN NOT NULL DEFAULT FALSE,
  called_at            TIMESTAMPTZ,
  pool_note            TEXT NOT NULL DEFAULT '',
  closed_at            TIMESTAMPTZ,
  closed_by            UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS practice_work_status_idx    ON public.practice_work(status) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS practice_work_colleague_idx ON public.practice_work(colleague_id);
CREATE INDEX IF NOT EXISTS practice_work_set_at_idx    ON public.practice_work(set_at);

ALTER TABLE public.practice_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.practice_work REPLICA IDENTITY FULL;

-- Admin/Top vedono tutto; un 'user' solo le righe del proprio piano di lavoro
DROP POLICY IF EXISTS "pw_read" ON public.practice_work;
CREATE POLICY "pw_read" ON public.practice_work FOR SELECT TO authenticated USING (
  is_approved() AND (
    can_see_all()
    OR set_by = auth.uid()
    OR colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = auth.uid())
  )
);
-- Aggiornamenti diretti (Chiamato / note pool / chiusura). Lo stato passa da set_practice_work().
DROP POLICY IF EXISTS "pw_update" ON public.practice_work;
CREATE POLICY "pw_update" ON public.practice_work FOR UPDATE TO authenticated USING (
  is_approved() AND (
    can_see_all()
    OR colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = auth.uid())
  )
) WITH CHECK (is_approved());

-- ── 3. Log giornaliero delle pratiche controllate ────────────────
-- Una riga per pratica e per giorno (ultimo stato della giornata).
-- Non viene mai ripulito: le pratiche "cancellate" dal piano restano conteggiate.
CREATE TABLE IF NOT EXISTS public.practice_checks (
  pratica_id   TEXT NOT NULL,
  check_day    DATE NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('conforme','integrazioni','da_chiamare','audit','help','xflat')),
  colleague_id TEXT REFERENCES public.colleagues(id) ON DELETE SET NULL,
  user_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pratica_id, check_day)
);
CREATE INDEX IF NOT EXISTS practice_checks_day_idx ON public.practice_checks(check_day);

ALTER TABLE public.practice_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.practice_checks REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS "pc_read" ON public.practice_checks;
CREATE POLICY "pc_read" ON public.practice_checks FOR SELECT TO authenticated USING (
  is_approved() AND (
    can_see_all()
    OR user_id = auth.uid()
    OR colleague_id = (SELECT colleague_id FROM public.profiles WHERE id = auth.uid())
  )
);

GRANT SELECT, UPDATE ON public.practice_work   TO authenticated;
GRANT SELECT         ON public.practice_checks TO authenticated;

-- ── 4. Imposta stato + nota di una pratica (unica via di scrittura) ──
CREATE OR REPLACE FUNCTION public.set_practice_work(
  p_pratica_id   TEXT,
  p_status       TEXT,
  p_note         TEXT,
  p_report_id    UUID DEFAULT NULL,
  p_colleague_id TEXT DEFAULT NULL,
  p_cognome      TEXT DEFAULT '',
  p_nome         TEXT DEFAULT '',
  p_tipologia    TEXT DEFAULT '',
  p_istituto     TEXT DEFAULT '',
  p_agente       TEXT DEFAULT ''
) RETURNS SETOF public.practice_work
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status TEXT := NULLIF(BTRIM(COALESCE(p_status, '')), '');
  v_note   TEXT := BTRIM(COALESCE(p_note, ''));
  v_day    DATE := (NOW() AT TIME ZONE 'Europe/Rome')::DATE;
  v_my_col TEXT;
BEGIN
  IF NOT public.is_approved() THEN
    RAISE EXCEPTION 'Non autorizzato';
  END IF;
  IF BTRIM(COALESCE(p_pratica_id, '')) = '' THEN
    RAISE EXCEPTION 'Pratica non valida';
  END IF;

  -- Un 'user' lavora solo sul proprio piano di lavoro
  IF NOT public.can_see_all() THEN
    SELECT colleague_id INTO v_my_col FROM public.profiles WHERE id = auth.uid();
    IF v_my_col IS NULL OR v_my_col IS DISTINCT FROM p_colleague_id THEN
      RAISE EXCEPTION 'Non autorizzato su questo piano di lavoro';
    END IF;
  END IF;

  -- Nota obbligatoria per tutti gli stati tranne Conforme
  IF v_status IS NOT NULL AND v_status <> 'conforme' AND v_note = '' THEN
    RAISE EXCEPTION 'Nota obbligatoria per questo stato';
  END IF;

  -- Stato rimosso: la pratica non conta piu' come controllata oggi
  IF v_status IS NULL THEN
    DELETE FROM public.practice_checks WHERE pratica_id = p_pratica_id AND check_day = v_day;
    IF v_note = '' THEN
      DELETE FROM public.practice_work WHERE pratica_id = p_pratica_id;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO public.practice_work AS w (
    pratica_id, status, note, report_id, colleague_id, set_by, set_at,
    cognome, nome, tipologia, istituto_finanziario, agente_attuale
  ) VALUES (
    p_pratica_id, v_status, v_note, p_report_id, p_colleague_id, auth.uid(), NOW(),
    COALESCE(p_cognome, ''), COALESCE(p_nome, ''), COALESCE(p_tipologia, ''),
    COALESCE(p_istituto, ''), COALESCE(p_agente, '')
  )
  ON CONFLICT (pratica_id) DO UPDATE SET
    status               = EXCLUDED.status,
    note                 = EXCLUDED.note,
    report_id            = EXCLUDED.report_id,
    colleague_id         = EXCLUDED.colleague_id,
    set_by               = EXCLUDED.set_by,
    set_at               = NOW(),
    cognome              = EXCLUDED.cognome,
    nome                 = EXCLUDED.nome,
    tipologia            = EXCLUDED.tipologia,
    istituto_finanziario = EXCLUDED.istituto_finanziario,
    agente_attuale       = EXCLUDED.agente_attuale,
    called               = FALSE,
    called_at            = NULL,
    pool_note            = '',
    closed_at            = NULL,
    closed_by            = NULL,
    updated_at           = NOW()
  RETURNING w.*;

  IF v_status IS NOT NULL THEN
    INSERT INTO public.practice_checks (pratica_id, check_day, status, colleague_id, user_id, updated_at)
    VALUES (p_pratica_id, v_day, v_status, p_colleague_id, auth.uid(), NOW())
    ON CONFLICT (pratica_id, check_day) DO UPDATE SET
      status       = EXCLUDED.status,
      colleague_id = EXCLUDED.colleague_id,
      user_id      = EXCLUDED.user_id,
      updated_at   = NOW();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_practice_work(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_practice_work(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── 5. Statistiche: controllate per collega/stato (oggi, settimana, mese, totale) ──
-- SECURITY INVOKER: valgono le policy di practice_checks (un 'user' vede solo le proprie).
CREATE OR REPLACE FUNCTION public.check_stats()
RETURNS TABLE (
  colleague_id TEXT,
  user_id      UUID,
  status       TEXT,
  n_day        BIGINT,
  n_week       BIGINT,
  n_month      BIGINT,
  n_total      BIGINT
)
LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH d AS (SELECT (NOW() AT TIME ZONE 'Europe/Rome')::DATE AS today)
  SELECT
    c.colleague_id,
    c.user_id,
    c.status,
    COUNT(*) FILTER (WHERE c.check_day = d.today),
    COUNT(*) FILTER (WHERE c.check_day >= DATE_TRUNC('week',  d.today)::DATE),
    COUNT(*) FILTER (WHERE c.check_day >= DATE_TRUNC('month', d.today)::DATE),
    COUNT(*)
  FROM public.practice_checks c CROSS JOIN d
  GROUP BY c.colleague_id, c.user_id, c.status;
$$;

REVOKE ALL ON FUNCTION public.check_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_stats() TO authenticated;

-- ── 6. Recupero degli stati inseriti con il vecchio sistema a colori ──
INSERT INTO public.practice_work (
  pratica_id, status, note, set_by, colleague_id, set_at,
  cognome, nome, tipologia, istituto_finanziario, agente_attuale
)
SELECT
  ps.pratica_id,
  CASE ps.color
    WHEN 'verde'     THEN 'conforme'
    WHEN 'giallo'    THEN 'integrazioni'
    WHEN 'arancione' THEN 'da_chiamare'
    WHEN 'rosso'     THEN 'audit'
    WHEN 'viola'     THEN 'xflat'
    WHEN 'azzurro'   THEN 'help'
  END,
  COALESCE((
    SELECT n.body FROM public.practice_notes n
    WHERE n.pratica_id = ps.pratica_id AND n.body <> ''
    ORDER BY n.created_at DESC LIMIT 1
  ), ''),
  ps.updated_by,
  pr.colleague_id,
  COALESCE(ps.updated_at, NOW()),
  COALESCE(p.cognome, ''), COALESCE(p.nome, ''), COALESCE(p.tipologia, ''),
  COALESCE(p.istituto_finanziario, ''), COALESCE(p.agente_attuale, '')
FROM public.practice_status ps
LEFT JOIN public.profiles pr ON pr.id = ps.updated_by
LEFT JOIN LATERAL (
  SELECT x.cognome, x.nome, x.tipologia, x.istituto_finanziario, x.agente_attuale
  FROM public.practices x
  WHERE x.pratica_id = ps.pratica_id
  ORDER BY x.created_at DESC LIMIT 1
) p ON TRUE
ON CONFLICT (pratica_id) DO NOTHING;

INSERT INTO public.practice_checks (pratica_id, check_day, status, colleague_id, user_id, updated_at)
SELECT w.pratica_id, (w.set_at AT TIME ZONE 'Europe/Rome')::DATE, w.status, w.colleague_id, w.set_by, w.set_at
FROM public.practice_work w
WHERE w.status IS NOT NULL
ON CONFLICT (pratica_id, check_day) DO NOTHING;

-- ── 7. Realtime ──────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['practice_work', 'practice_checks'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;
