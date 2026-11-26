-- @threenative/backend: the room lobby, one row per open room.
--
-- `create` and `quickJoin` insert a row; the room itself refreshes `players`/`updated_at` while
-- anyone is connected (on join, on leave, and on its 60 s alarm) and deletes it when the last
-- member leaves. `list` and `quickJoin` only offer rows refreshed within the last two minutes, so
-- a room whose Durable Object died ungracefully stops being reachable instead of lingering.

CREATE TABLE IF NOT EXISTS rooms (
  game_id TEXT NOT NULL,
  code TEXT NOT NULL,
  public INTEGER NOT NULL CHECK (public IN (0, 1)),
  players INTEGER NOT NULL,
  max INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, code)
);

-- The lobby: public, fresh rooms with space left, newest first.
CREATE INDEX IF NOT EXISTS rooms_lobby ON rooms (game_id, public, updated_at);
