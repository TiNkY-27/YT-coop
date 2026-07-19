-- ============================================================
-- MIGRACIÓN: nueva estructura de queue (videos individuales)
-- Ejecutar en SQL Editor de Supabase.
-- IMPORTANTE: hace TRUNCATE de queue (borra filas existentes).
-- ============================================================

-- 1) Quitar columnas viejas de queue
ALTER TABLE queue DROP COLUMN IF EXISTS playlist_id;
ALTER TABLE queue DROP COLUMN IF EXISTS name;

-- 2) Agregar columnas nuevas (todas nullable por ahora)
ALTER TABLE queue ADD COLUMN IF NOT EXISTS video_id TEXT;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS thumbnail TEXT;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS duration INTEGER;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS source_playlist_id TEXT;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS source_playlist_name TEXT;

-- 3) Llenar NULLs antes de aplicar NOT NULL (defensivo)
UPDATE queue SET video_id = '' WHERE video_id IS NULL;
UPDATE queue SET title = 'Sin titulo' WHERE title IS NULL;
UPDATE queue SET thumbnail = '' WHERE thumbnail IS NULL;

-- 4) Aplicar NOT NULL y defaults
ALTER TABLE queue ALTER COLUMN video_id SET NOT NULL;
ALTER TABLE queue ALTER COLUMN title SET NOT NULL;
ALTER TABLE queue ALTER COLUMN title SET DEFAULT 'Sin titulo';
ALTER TABLE queue ALTER COLUMN thumbnail SET NOT NULL;
ALTER TABLE queue ALTER COLUMN thumbnail SET DEFAULT '';

-- 5) Borrar todas las filas (TRUNCATE pedido por el usuario)
TRUNCATE TABLE queue;

-- 6) Quitar columnas viejas de rooms
ALTER TABLE rooms DROP COLUMN IF EXISTS current_queue_id;
ALTER TABLE rooms DROP COLUMN IF EXISTS current_playlist_id;

-- 7) Agregar current_queue_index si no existe (apunta a la fila de queue)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rooms' AND column_name = 'current_queue_index'
  ) THEN
    ALTER TABLE rooms ADD COLUMN current_queue_index INTEGER DEFAULT 0;
  END IF;
END $$;

-- 8) Forzar reload del schema cache de PostgREST
NOTIFY pgrst, 'reload schema';
