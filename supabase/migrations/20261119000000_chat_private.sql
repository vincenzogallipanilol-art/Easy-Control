-- ================================================================
-- Chat privata + messaggi da leggere
--  - chat_messages.recipient_id: NULL = chat di gruppo, altrimenti messaggio privato
--    (visibile solo a mittente e destinatario)
--  - chat_reads: ultima lettura per utente e conversazione ('group' oppure id dell'altro utente)
-- ================================================================
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS chat_messages_recipient_idx ON public.chat_messages (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_created_idx   ON public.chat_messages (created_at DESC);

DROP POLICY IF EXISTS "chat_read" ON public.chat_messages;
CREATE POLICY "chat_read" ON public.chat_messages FOR SELECT TO authenticated
  USING (is_approved() AND (recipient_id IS NULL OR recipient_id = (SELECT auth.uid()) OR author_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS "chat_insert" ON public.chat_messages;
CREATE POLICY "chat_insert" ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (is_approved() AND author_id = (SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.chat_reads (
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conv          TEXT NOT NULL,
  last_read_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conv)
);
ALTER TABLE public.chat_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_reads_select" ON public.chat_reads;
CREATE POLICY "chat_reads_select" ON public.chat_reads FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "chat_reads_insert" ON public.chat_reads;
CREATE POLICY "chat_reads_insert" ON public.chat_reads FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "chat_reads_update" ON public.chat_reads;
CREATE POLICY "chat_reads_update" ON public.chat_reads FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
