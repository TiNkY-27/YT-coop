-- ============================================================
-- MIGRACIÓN: agregar client_id a rooms para deteccion de eco
-- Ejecutar en SQL Editor de Supabase.
-- Idempotente: se puede correr varias veces sin error.
-- ============================================================

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS client_id TEXT;

-- Forzar reload del schema cache de PostgREST
NOTIFY pgrst, 'reload schema';
