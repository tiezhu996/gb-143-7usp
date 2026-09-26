import { PoolClient } from 'pg';
import { LEVEL_THRESHOLDS, BADGE_NAMES, BADGE_DESCRIPTIONS, Badge, BadgeEvent, BadgeSyncResult } from '../types';
import pool from '../db/pool';

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

interface SyncBadgesOptions {
  newLevel: number;
  /** 触发本次同步的积分变动原因，如「投诉处理扣分」 */
  reason: string;
  pointsBefore?: number;
  pointsAfter?: number;
  levelBefore?: number;
  relatedId?: string;
  relatedType?: string;
}

const insertBadgeEvent = async (
  client: PoolClient,
  event: {
    volunteer_id: string;
    badge_id?: string;
    star_level: number;
    event_type: BadgeEvent['event_type'];
    reason: string;
    points_before?: number;
    points_after?: number;
    level_before?: number;
    level_after?: number;
    related_id?: string;
    related_type?: string;
  }
): Promise<BadgeEvent> => {
  const result = await client.query(
    `INSERT INTO badge_events
       (volunteer_id, badge_id, star_level, event_type, reason,
        points_before, points_after, level_before, level_after, related_id, related_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      event.volunteer_id,
      event.badge_id || null,
      event.star_level,
      event.event_type,
      event.reason,
      event.points_before ?? null,
      event.points_after ?? null,
      event.level_before ?? null,
      event.level_after ?? null,
      event.related_id || null,
      event.related_type || null,
    ]
  );
  return result.rows[0];
};

/**
 * 徽章随等级走：在调用方事务内执行。
 * - 当前等级以下（含）的有效徽章保留，一星徽章永不收回；
 * - 高于当前等级的有效徽章收回，记录收回时间和原因；
 * - 当前等级应有的徽章缺失则授予，曾被收回的重新授予（复活原行，同一星级不产生两份）。
 */
export const syncBadgesToLevel = async (
  client: PoolClient,
  volunteerId: string,
  options: SyncBadgesOptions
): Promise<BadgeSyncResult> => {
  const awarded: Badge[] = [];
  const revoked: Badge[] = [];
  const events: BadgeEvent[] = [];

  const badgesResult = await client.query(
    'SELECT * FROM badges WHERE volunteer_id = $1 FOR UPDATE',
    [volunteerId]
  );
  const badges = badgesResult.rows as Badge[];

  // 1. 收回高于当前等级线的徽章（一星为起始徽章，不收回）
  for (const badge of badges) {
    if (badge.status === 'active' && badge.star_level >= 2 && badge.star_level > options.newLevel) {
      const threshold = LEVEL_THRESHOLDS[badge.star_level];
      const reason = `积分低于${threshold}分星级线，徽章收回（${options.reason}）`;

      const updateResult = await client.query(
        `UPDATE badges
         SET status = 'revoked',
             revoked_at = CURRENT_TIMESTAMP,
             revoke_reason = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [reason, badge.id]
      );
      const revokedBadge = updateResult.rows[0] as Badge;
      revoked.push(revokedBadge);

      const event = await insertBadgeEvent(client, {
        volunteer_id: volunteerId,
        badge_id: revokedBadge.id,
        star_level: badge.star_level,
        event_type: 'revoked',
        reason,
        points_before: options.pointsBefore,
        points_after: options.pointsAfter,
        level_before: options.levelBefore,
        level_after: options.newLevel,
        related_id: options.relatedId,
        related_type: options.relatedType,
      });
      events.push(event);
    }
  }

  // 2. 补发/重新授予当前等级应有的徽章（二星及以上）
  for (let level = 2; level <= options.newLevel; level++) {
    const existing = badges.find(b => b.star_level === level);
    if (existing && existing.status === 'active') {
      continue;
    }

    const badgeName = BADGE_NAMES[level];
    const description = BADGE_DESCRIPTIONS[level];
    const threshold = LEVEL_THRESHOLDS[level];

    let badge: Badge;
    let eventType: BadgeEvent['event_type'];
    let reason: string;

    if (existing && existing.status === 'revoked') {
      // 重新拿到：复活原行，同一星级仍只有一份
      const updateResult = await client.query(
        `UPDATE badges
         SET status = 'active',
             badge_name = $1,
             description = $2,
             awarded_at = CURRENT_TIMESTAMP,
             revoked_at = NULL,
             revoke_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *`,
        [badgeName, description, existing.id]
      );
      badge = updateResult.rows[0];
      eventType = 'reawarded';
      reason = `积分重新达到${threshold}分星级线，重新授予徽章（${options.reason}）`;
    } else {
      const insertResult = await client.query(
        `INSERT INTO badges (volunteer_id, star_level, badge_name, description, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING *`,
        [volunteerId, level, badgeName, description]
      );
      badge = insertResult.rows[0];
      eventType = 'awarded';
      reason = `积分达到${threshold}分星级线，授予徽章（${options.reason}）`;
    }

    awarded.push(badge);

    const event = await insertBadgeEvent(client, {
      volunteer_id: volunteerId,
      badge_id: badge.id,
      star_level: level,
      event_type: eventType,
      reason,
      points_before: options.pointsBefore,
      points_after: options.pointsAfter,
      level_before: options.levelBefore,
      level_after: options.newLevel,
      related_id: options.relatedId,
      related_type: options.relatedType,
    });
    events.push(event);
  }

  return { awarded, revoked, events };
};

/** 当前持有的有效徽章 */
export const getVolunteerBadges = async (volunteerId: string): Promise<Badge[]> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM badges
       WHERE volunteer_id = $1 AND status = 'active'
       ORDER BY star_level`,
      [volunteerId]
    );
    return result.rows;
  } finally {
    client.release();
  }
};

/** 徽章授予/收回历史 */
export const getVolunteerBadgeHistory = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20
): Promise<{ events: BadgeEvent[]; pagination: {
    page: number; page_size: number; total: number; total_pages: number;
  } }> => {
  const client = await pool.connect();
  try {
    const offset = (page - 1) * pageSize;

    const countResult = await client.query(
      'SELECT COUNT(*) as total FROM badge_events WHERE volunteer_id = $1',
      [volunteerId]
    );

    const result = await client.query(
      `SELECT * FROM badge_events
       WHERE volunteer_id = $1
       ORDER BY created_at DESC, star_level DESC
       LIMIT $2 OFFSET $3`,
      [volunteerId, pageSize, offset]
    );

    return {
      events: result.rows,
      pagination: {
        page,
        page_size: pageSize,
        total: parseInt(countResult.rows[0].total),
        total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
      },
    };
  } finally {
    client.release();
  }
};

export { LEVEL_THRESHOLDS, BADGE_NAMES };
