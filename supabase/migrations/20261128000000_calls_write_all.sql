-- Chiamate: tutti gli utenti approvati possono scrivere sulle pratiche "Da chiamare" (Chiamato, note chiamata, esito)
-- e si traccia chi ha segnato la chiamata.
ALTER TABLE public.practice_work ADD COLUMN IF NOT EXISTS called_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

DROP POLICY IF EXISTS "pw_update_calls" ON public.practice_work;
CREATE POLICY "pw_update_calls" ON public.practice_work FOR UPDATE TO authenticated USING (
  (SELECT is_approved()) AND status = 'da_chiamare' AND closed_at IS NULL
) WITH CHECK ((SELECT is_approved()));

-- Esito (Conforme / Richiesta integrazioni) anche da chi non e' il titolare del piano, ma solo su pratiche aperte in "Da chiamare"
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

  -- Un 'user' lavora solo sul proprio piano di lavoro, tranne che per dare l'esito a una pratica "Da chiamare"
  IF NOT public.can_see_all() THEN
    SELECT colleague_id INTO v_my_col FROM public.profiles WHERE id = auth.uid();
    IF (v_my_col IS NULL OR v_my_col IS DISTINCT FROM p_colleague_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.practice_work x
         WHERE x.pratica_id = p_pratica_id AND x.status = 'da_chiamare' AND x.closed_at IS NULL
           AND x.colleague_id IS NOT DISTINCT FROM p_colleague_id
       ) THEN
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
    called_by            = NULL,
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
