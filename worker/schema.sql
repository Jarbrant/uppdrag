-- ============================================================
-- FIL: worker/schema.sql (HEL FIL)
-- AO 1/6 — D1: partners + partner_invites + rewards
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- TABLE: partners
-- ============================================================
CREATE TABLE IF NOT EXISTS partners (
  partnerId  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pinHash    TEXT, -- nullable tills satt
  isActive   INTEGER NOT NULL DEFAULT 1,
  createdAt  INTEGER NOT NULL
);

-- ============================================================
-- TABLE: partner_invites
-- ============================================================
CREATE TABLE IF NOT EXISTS partner_invites (
  inviteToken TEXT PRIMARY KEY,
  partnerId   TEXT NOT NULL,
  expiresAt   INTEGER NOT NULL,
  usedAt      INTEGER, -- nullable
  createdAt   INTEGER NOT NULL,
  FOREIGN KEY (partnerId) REFERENCES partners(partnerId) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_partner_invites_partnerId ON partner_invites(partnerId);
CREATE INDEX IF NOT EXISTS idx_partner_invites_expiresAt ON partner_invites(expiresAt);

-- ============================================================
-- TABLE: rewards
-- ============================================================
CREATE TABLE IF NOT EXISTS rewards (
  rewardId    TEXT PRIMARY KEY,
  partnerId   TEXT NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL,      -- "percent" | "freebie" | "bogo" | "custom"
  valueText   TEXT NOT NULL,      -- t.ex "10%" / "Gratis kaffe"
  stock       INTEGER NOT NULL,
  ttlMinutes  INTEGER NOT NULL,
  tier        TEXT NOT NULL,      -- "cp" | "final"
  isActive    INTEGER NOT NULL DEFAULT 1,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  FOREIGN KEY (partnerId) REFERENCES partners(partnerId) ON DELETE CASCADE
);

-- Index enligt KRAV
CREATE INDEX IF NOT EXISTS idx_rewards_partnerId ON rewards(partnerId);
CREATE INDEX IF NOT EXISTS idx_rewards_active_stock_tier ON rewards(isActive, stock, tier);

-- Extra: snabb listning per tier
CREATE INDEX IF NOT EXISTS idx_rewards_tier ON rewards(tier);
