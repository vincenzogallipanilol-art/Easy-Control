-- Note chiamate: data e autore dell'ultima modifica (Note chiamata e punti delle Note della pratica da chiamare)
ALTER TABLE public.practice_work
  ADD COLUMN IF NOT EXISTS pool_note_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pool_note_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS note_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS note_edited_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
