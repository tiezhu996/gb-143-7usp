import { Pool, PoolClient } from 'pg';
import { LEVEL_THRESHOLDS, BADGE_NAMES, BADGE_DESCRIPTIONS, Badge } from '../types';
import pool from '../db/pool';

type Queryable = Pool | PoolClient;

export const calculateLevel = (totalPoints: number): number => {
  let currentLevel = 1;
  for (let level = 5; level >= 1; level--) {
    if (totalPoints >= LEVEL_THRESHOLDS[level]) {
      currentLevel = level;
      break;
    }
  }
  return currentLevel;
};

export const checkNewBadges = async (
  volunteerId: string,
  newLevel: number,
  currentBadges: Badge[],
  client?: Queryable
): Promise<Badge[]> => {
  const newBadges: Badge[] = [];
  const currentLevels = currentBadges.map(b => b.star_level);
  const db: Queryable = client || pool;

  for (let level = 2; level <= newLevel; level++) {
    if (!currentLevels.includes(level)) {
      const badgeName = BADGE_NAMES[level];
      const description = BADGE_DESCRIPTIONS[level];

      const result = await db.query(
        `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [volunteerId, level, badgeName, description]
      );
      newBadges.push(result.rows[0]);
    }
  }

  return newBadges;
};

export const revokeBadgesAboveLevel = async (
  volunteerId: string,
  newLevel: number,
  reason: string,
  client?: Queryable
): Promise<Badge[]> => {
  const db: Queryable = client || pool;
  const result = await db.query(
    `UPDATE badges
     SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = $3
     WHERE volunteer_id = $1 AND star_level > $2 AND revoked_at IS NULL
     RETURNING *`,
    [volunteerId, newLevel, reason]
  );
  return result.rows;
};

export const getVolunteerBadges = async (volunteerId: string): Promise<Badge[]> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM badges WHERE volunteer_id = $1 AND revoked_at IS NULL ORDER BY star_level',
      [volunteerId]
    );
    return result.rows;
  } finally {
    client.release();
  }
};

export const getVolunteerBadgeHistory = async (volunteerId: string): Promise<Badge[]> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM badges WHERE volunteer_id = $1 ORDER BY awarded_at DESC, star_level',
      [volunteerId]
    );
    return result.rows;
  } finally {
    client.release();
  }
};

export { LEVEL_THRESHOLDS, BADGE_NAMES };
