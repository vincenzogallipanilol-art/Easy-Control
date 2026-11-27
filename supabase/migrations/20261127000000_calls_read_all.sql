-- Menu "Chiamate": tutti gli utenti approvati possono consultare le pratiche in "Da chiamare" (sola lettura)
DROP POLICY IF EXISTS "pw_read_calls" ON public.practice_work;
CREATE POLICY "pw_read_calls" ON public.practice_work FOR SELECT TO authenticated USING (
  (SELECT is_approved()) AND status = 'da_chiamare' AND closed_at IS NULL
);
