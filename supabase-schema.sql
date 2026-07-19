-- Esquema SQL para la app de salas compartidas de YouTube.
-- Ejecutar en el SQL Editor de Supabase.

-- 1. Tablas

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT 'Sala',
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_open BOOLEAN NOT NULL DEFAULT true,
  current_video_id TEXT,
  current_queue_index INTEGER DEFAULT 0,
  playback_time DOUBLE PRECISION DEFAULT 0,
  player_state TEXT DEFAULT 'paused',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Sin titulo',
  thumbnail TEXT DEFAULT '',
  channel TEXT,
  duration INTEGER,
  source_playlist_id TEXT,
  source_playlist_name TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code);
CREATE INDEX IF NOT EXISTS idx_queue_room_position ON queue(room_id, "position");

-- 2. Realtime

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE rooms;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE participants;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE playlists;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE queue;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- 3. Funciones auxiliares

CREATE OR REPLACE FUNCTION generate_room_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  code TEXT;
BEGIN
  LOOP
    code := upper(substring(md5(random()::text), 1, 6));
    IF NOT EXISTS (SELECT 1 FROM rooms WHERE rooms.code = code) THEN
      RETURN code;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION create_room(room_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_id UUID;
  new_code TEXT;
BEGIN
  new_code := generate_room_code();
  INSERT INTO rooms (code, name, admin_id, is_open, active)
  VALUES (new_code, room_name, auth.uid(), true, true)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION room_exists_active(room_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET row_security = off
AS $$
  SELECT EXISTS (SELECT 1 FROM rooms WHERE id = room_uuid AND active = true);
$$;

CREATE OR REPLACE FUNCTION get_room_id_by_code(room_code TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET row_security = off
AS $$
  SELECT id FROM rooms WHERE code = room_code AND active = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION user_is_participant_in_room(target_room UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM participants
    WHERE room_id = target_room AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION user_is_admin_of_room(target_room UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM rooms
    WHERE id = target_room AND admin_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION next_queue_position(target_room UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET row_security = off
AS $$
  SELECT COALESCE(MAX("position"), 0) + 1 FROM queue WHERE room_id = target_room;
$$;

CREATE OR REPLACE FUNCTION pop_first_queue_item(target_room UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = off
AS $$
DECLARE
  item_id UUID;
BEGIN
  SELECT id INTO item_id
  FROM queue
  WHERE room_id = target_room
  ORDER BY "position" ASC, created_at ASC
  LIMIT 1;

  IF item_id IS NOT NULL THEN
    DELETE FROM queue WHERE id = item_id;
  END IF;

  RETURN item_id;
END $$;

-- 4. Triggers

CREATE OR REPLACE FUNCTION transfer_admin_on_leave()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET row_security = off
AS $$
DECLARE
  new_admin_id UUID;
BEGIN
  IF NOT OLD.is_admin THEN
    RETURN OLD;
  END IF;

  SELECT user_id INTO new_admin_id
  FROM participants
  WHERE room_id = OLD.room_id
  ORDER BY joined_at ASC
  LIMIT 1;

  IF new_admin_id IS NOT NULL THEN
    UPDATE rooms SET admin_id = new_admin_id WHERE id = OLD.room_id;
    UPDATE participants SET is_admin = true
    WHERE room_id = OLD.room_id AND user_id = new_admin_id;
  ELSE
    UPDATE rooms SET active = false WHERE id = OLD.room_id;
  END IF;

  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_transfer_admin ON participants;
CREATE TRIGGER trg_transfer_admin
AFTER DELETE ON participants
FOR EACH ROW
EXECUTE FUNCTION transfer_admin_on_leave();

CREATE OR REPLACE FUNCTION enforce_room_update_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.admin_id IS DISTINCT FROM auth.uid() THEN
    IF NEW.admin_id IS DISTINCT FROM OLD.admin_id
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.active IS DISTINCT FROM OLD.active THEN
      RAISE EXCEPTION 'Solo el admin puede cambiar admin_id, codigo, nombre o estado activo';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_room_update ON rooms;
CREATE TRIGGER trg_enforce_room_update
BEFORE UPDATE ON rooms
FOR EACH ROW
EXECUTE FUNCTION enforce_room_update_permissions();

-- 5. Row Level Security

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue ENABLE ROW LEVEL SECURITY;

-- rooms
DROP POLICY IF EXISTS "rooms_insert_own" ON rooms;
CREATE POLICY "rooms_insert_own" ON rooms
  FOR INSERT
  WITH CHECK (auth.uid() = admin_id);

DROP POLICY IF EXISTS "rooms_select_participants" ON rooms;
CREATE POLICY "rooms_select_participants" ON rooms
  FOR SELECT
  USING (
    admin_id = auth.uid()
    OR user_is_participant_in_room(id)
  );

DROP POLICY IF EXISTS "rooms_update_by_admin_or_open" ON rooms;
CREATE POLICY "rooms_update_by_admin_or_open" ON rooms
  FOR UPDATE
  USING (
    admin_id = auth.uid()
    OR (is_open = true AND user_is_participant_in_room(id))
  )
  WITH CHECK (true);

-- participants
DROP POLICY IF EXISTS "participants_select_same_room" ON participants;
CREATE POLICY "participants_select_same_room" ON participants
  FOR SELECT
  USING (
    user_is_participant_in_room(room_id)
    OR user_is_admin_of_room(room_id)
  );

DROP POLICY IF EXISTS "participants_insert_self" ON participants;
CREATE POLICY "participants_insert_self" ON participants
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND room_exists_active(room_id)
  );

DROP POLICY IF EXISTS "participants_delete_self" ON participants;
CREATE POLICY "participants_delete_self" ON participants
  FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "participants_update_self" ON participants;
CREATE POLICY "participants_update_self" ON participants
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- playlists
DROP POLICY IF EXISTS "playlists_own_crud" ON playlists;
CREATE POLICY "playlists_own_crud" ON playlists
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- queue
DROP POLICY IF EXISTS "queue_select_room_members" ON queue;
CREATE POLICY "queue_select_room_members" ON queue
  FOR SELECT
  USING (user_is_participant_in_room(room_id));

DROP POLICY IF EXISTS "queue_insert_room_members" ON queue;
CREATE POLICY "queue_insert_room_members" ON queue
  FOR INSERT
  WITH CHECK (
    auth.uid() = created_by
    AND user_is_participant_in_room(room_id)
  );

DROP POLICY IF EXISTS "queue_delete_room_members" ON queue;
CREATE POLICY "queue_delete_room_members" ON queue
  FOR DELETE
  USING (user_is_participant_in_room(room_id));

DROP POLICY IF EXISTS "queue_update_room_members" ON queue;
CREATE POLICY "queue_update_room_members" ON queue
  FOR UPDATE
  USING (user_is_participant_in_room(room_id))
  WITH CHECK (user_is_participant_in_room(room_id));

-- 6. Permisos sobre funciones

GRANT EXECUTE ON FUNCTION generate_room_code() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION create_room(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION room_exists_active(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_room_id_by_code(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION user_is_participant_in_room(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION user_is_admin_of_room(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION next_queue_position(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION pop_first_queue_item(uuid) TO authenticated, anon;
