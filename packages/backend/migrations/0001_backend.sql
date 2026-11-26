-- @threenative/backend: player data for one game, in one D1 database.
--
-- Two tables only. `kv` is one private value per player key; `docs` is a per-game collection
-- where a document belongs to one player, is readable by that player alone when `scope` is
-- `private`, and by every player of the game when it is `public`. `size` is the UTF-8 byte length
-- of the stored JSON, so the per-game budget is one SUM() away.

CREATE TABLE IF NOT EXISTS kv (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  size INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_id, key)
);

CREATE TABLE IF NOT EXISTS docs (
  game_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('private', 'public')),
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, collection, doc_id)
);

-- Game-wide totals: the 50 MB / 10,000 row budget and `deleteGameData`.
CREATE INDEX IF NOT EXISTS kv_game ON kv (game_id);
CREATE INDEX IF NOT EXISTS docs_game ON docs (game_id);

-- Per-owner counts: the 50-key and 100-document caps.
CREATE INDEX IF NOT EXISTS kv_player ON kv (game_id, player_id);
CREATE INDEX IF NOT EXISTS docs_owner ON docs (game_id, collection, owner_id);

-- Public listing: the caller's documents of any scope plus other players' public ones.
CREATE INDEX IF NOT EXISTS docs_scope ON docs (game_id, collection, scope);
