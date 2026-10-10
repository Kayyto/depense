-- Carnet de dépenses de voyage — base D1 (remplace Firestore : collection "trips").
-- Un voyage = une ligne, identifiée par son code (le même code sur tous les appareils / personnes).
CREATE TABLE IF NOT EXISTS trips (
  code        TEXT PRIMARY KEY,
  data        TEXT NOT NULL,            -- JSON { tripName, people[], expenses[] }
  rev         INTEGER NOT NULL DEFAULT 1,
  owner_id    TEXT,                     -- compte central qui a créé le voyage
  updated_by  TEXT,                     -- dernier compte central ayant modifié
  updated_at  TEXT NOT NULL
);

-- Dernier code de voyage utilisé par chaque compte (pour le retrouver sur un nouvel appareil).
CREATE TABLE IF NOT EXISTS prefs (
  account_id  TEXT PRIMARY KEY,
  last_code   TEXT,
  updated_at  TEXT NOT NULL
);
