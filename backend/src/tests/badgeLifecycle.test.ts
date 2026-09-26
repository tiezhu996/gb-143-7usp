/* eslint-disable @typescript-eslint/no-explicit-any, prefer-rest-params, @typescript-eslint/no-var-requires */
/**
 * 徽章随等级联动的生命周期验证（pg-mem 内存库，无需真实 PostgreSQL）。
 *
 * 场景：
 * 1. 涨分到 1000：依次授予二~五星徽章
 * 2. 投诉扣分，积分掉到 600 以下：收回五星（记时间/原因），四星及以下保留
 * 3. 管理员再扣分到 100 以下：三、四星同时收回，二星收回，一星起始徽章保留
 * 4. 管理员调回积分：逐档重新授予，同一星级只有一行（不产生两份），历史含 awarded/revoked/reawarded
 * 5. 详情/徽章接口仅返回有效徽章；历史接口能查授予和收回
 */
import Module from 'module';
import { randomUUID } from 'crypto';
import { newDb } from 'pg-mem';

const db = newDb();
db.public.registerFunction({
  name: 'gen_random_uuid',
  returns: 'uuid' as any,
  impure: true,
  implementation: () => randomUUID(),
});

const schema = `
  CREATE TABLE volunteers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(100),
    total_points INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    credit_score INTEGER NOT NULL DEFAULT 100,
    service_count INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE service_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    volunteer_id UUID NOT NULL,
    service_type VARCHAR(50) NOT NULL,
    duration_hours numeric NOT NULL,
    rating INTEGER NOT NULL DEFAULT 5,
    points_earned INTEGER NOT NULL DEFAULT 0,
    is_no_show BOOLEAN NOT NULL DEFAULT false,
    location VARCHAR(200),
    description TEXT,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    volunteer_id UUID NOT NULL,
    star_level INTEGER NOT NULL,
    badge_name VARCHAR(100) NOT NULL,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP,
    revoke_reason VARCHAR(200),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(volunteer_id, star_level)
  );
  CREATE TABLE complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    volunteer_id UUID NOT NULL,
    complainant_id UUID,
    complaint_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    resolution TEXT,
    credit_penalty INTEGER DEFAULT 0,
    points_penalty INTEGER DEFAULT 0,
    handled_by VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
  );
  CREATE TABLE credit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL,
    change_amount INTEGER NOT NULL, reason VARCHAR(200) NOT NULL,
    before_score INTEGER NOT NULL, after_score INTEGER NOT NULL,
    related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE points_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL,
    change_amount INTEGER NOT NULL, reason VARCHAR(200) NOT NULL,
    before_points INTEGER NOT NULL, after_points INTEGER NOT NULL,
    related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), admin_id VARCHAR(100) NOT NULL,
    action VARCHAR(50) NOT NULL, target_type VARCHAR(50) NOT NULL, target_id UUID,
    old_value JSONB, new_value JSONB, reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE badge_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), volunteer_id UUID NOT NULL, badge_id UUID,
    star_level INTEGER NOT NULL, event_type VARCHAR(20) NOT NULL, reason VARCHAR(200) NOT NULL,
    points_before INTEGER, points_after INTEGER, level_before INTEGER, level_after INTEGER,
    related_id UUID, related_type VARCHAR(50), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;
db.public.none(schema);

// 拦截 require('pg')，让应用代码使用 pg-mem 的连接池
const memPool = db.adapters.createPg().Pool;
const originalLoad = (Module as any)._load;
(Module as any)._load = function patchedLoad(request: string) {
  if (request === 'pg') {
    return { ...originalLoad.apply(this, arguments), Pool: memPool };
  }
  return originalLoad.apply(this, arguments);
};

import { createVolunteer, getVolunteerSummary } from '../services/volunteerManager';
import { adjustPoints } from '../services/adminService';
import { createComplaint, handleComplaint } from '../services/complaintService';
import { getVolunteerBadges, getVolunteerBadgeHistory } from '../services/badgeService';
import { createServiceRecord } from '../services/volunteerService';

// pg-mem 兼容：剥离 FOR UPDATE 锁子句
const { default: pool } = require('../db/pool');
const origConnect = pool.connect.bind(pool);
pool.connect = async (...args: any[]) => {
  const client = await origConnect(...args);
  const origQuery = client.query.bind(client);
  client.query = (text: string, params?: any[]) => {
    const cleaned = typeof text === 'string' ? text.replace(/\s+FOR UPDATE/g, '') : text;
    return origQuery(cleaned, params);
  };
  return client;
};

let passed = 0;
let failed = 0;
const assert = (name: string, cond: boolean, extra?: any) => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (extra !== undefined) console.log('    ', JSON.stringify(extra));
  }
};
const assertEq = (name: string, actual: any, expected: any) =>
  assert(`${name} (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`, actual === expected, { actual, expected });

const run = async () => {
  console.log('\n== 前置：创建志愿者 ==');
  const v = await createVolunteer('徽章联动测试');
  const vid = v.data!.id;

  console.log('\n== 场景1：积分涨到 650，授予二~四星 ==');
  let adj = await adjustPoints(vid, 650, 'admin', '测试奖励累计到四星线以上');
  assertEq('返回 newLevel=4', adj.data!.newLevel, 4);
  assertEq('本次授予 3 枚', adj.data!.newBadges.length, 3);
  assertEq('本次无收回', adj.data!.revokedBadges.length, 0);
  const badgesAt4 = await getVolunteerBadges(vid);
  assertEq('有效徽章 3 枚（无一星）', badgesAt4.length, 3);

  console.log('\n== 场景2：投诉扣分 75，积分 575（四星线以下），收回四星，低星保留 ==');
  const c = await createComplaint(vid, 'violation', '测试用违规投诉描述');
  const handled = await handleComplaint(c.data!.id, 'resolve', 'admin', '投诉成立按严重度处理扣回积分', 3);
  assertEq('投诉后积分=575', handled.data!.newTotalPoints, 575);
  assertEq('投诉后等级降为 3', handled.data!.newLevel, 3);
  assertEq('投诉收回四星 1 枚', handled.data!.revokedBadges.map((b: any) => b.star_level).join(','), '4');
  let badges = await getVolunteerBadges(vid);
  const levels3 = badges.map((b: any) => b.star_level).sort();
  assertEq('有效徽章剩 2/3 星', JSON.stringify(levels3), JSON.stringify([2, 3]));

  // 四星行应存在且为 revoked，带收回时间和原因
  const fourStar = await pool.query(
    "SELECT * FROM badges WHERE volunteer_id = $1 AND star_level = 4", [vid]);
  const revokedFour = fourStar.rows[0];
  assertEq('四星状态=revoked', revokedFour.status, 'revoked');
  assert('四星有收回时间', !!revokedFour.revoked_at, revokedFour);
  assert('四星收回原因含星级线说明',
    /积分低于600分星级线/.test(revokedFour.revoke_reason), revokedFour.revoke_reason);
  assert('四星收回原因含投诉扣分来源',
    /投诉处理扣分/.test(revokedFour.revoke_reason), revokedFour.revoke_reason);

  console.log('\n== 场景3：继续下调到 80 分（二星线以下），二/三星收回，一星保留 ==');
  adj = await adjustPoints(vid, -495, 'admin', '管理员继续下调积分到二星线以下');
  assertEq('等级降为 1', adj.data!.newLevel, 1);
  assertEq('收回 2/3 共两枚', adj.data!.revokedBadges.map((b: any) => b.star_level).sort().join(','), '2,3');
  badges = await getVolunteerBadges(vid);
  assertEq('有效徽章为 0 枚（一星为起始等级不发徽章）', badges.length, 0);

  console.log('\n== 场景4：涨回 1000，逐档重新授予，同一星级不产生两份 ==');
  adj = await adjustPoints(vid, 920, 'admin', '管理员恢复积分重新达到五星线');
  assertEq('新等级 5', adj.data!.newLevel, 5);
  assertEq('重新授予 4 枚', adj.data!.newBadges.length, 4);
  const allBadgeRows = await pool.query('SELECT * FROM badges WHERE volunteer_id = $1', [vid]);
  assertEq('badges 表总共仍只有 4 行（同一星级无两份）', allBadgeRows.rows.length, 4);
  assert('四行全部 active', allBadgeRows.rows.every((r: any) => r.status === 'active'));
  // 重新授予后 awarded_at 应为新时间、revoked 字段清空
  assert('重新授予的四星行清空了收回信息',
    allBadgeRows.rows.find((r: any) => r.star_level === 4).revoked_at === null);

  const history = await getVolunteerBadgeHistory(vid, 1, 50);
  const types = history.events.map((e: any) => e.event_type);
  assert('历史含 revoked 事件', types.includes('revoked'));
  assert('历史含 awarded 事件', types.includes('awarded'));
  assert('历史含 reawarded 事件', types.includes('reawarded'));
  // 事件计数：首次授予3 + 投诉收回四星1 + 管理员收回2/3两枚 + 重授4 = 10
  assertEq('历史事件共 10 条', history.events.length, 10);
  const revokedEvents = history.events.filter((e: any) => e.event_type === 'revoked');
  assert('每条收回事件都有原因和变动前后积分/等级',
    revokedEvents.every((e: any) => e.reason && e.points_after != null && e.level_after != null));
  // 投诉导致的四星收回事件关联了 complaint
  const fourRevoke = history.events.find((e: any) => e.star_level === 4 && e.event_type === 'revoked')!;
  assertEq('四星收回事件关联类型=complaint', fourRevoke.related_type, 'complaint');
  assert('四星收回事件有关联投诉ID', !!fourRevoke.related_id);

  console.log('\n== 场景5：详情页/徽章接口仅显示有效徽章 ==');
  // 再降一次级制造 revoked 与 active 并存
  await adjustPoints(vid, -500, 'admin', '管理员下调积分制造混合状态验证详情');
  const summary = await getVolunteerSummary(vid);
  const summaryLevels = (summary.data!.badges as any[]).map(b => b.star_level).sort();
  assertEq('summary 仅含 2/3 星有效徽章', JSON.stringify(summaryLevels), JSON.stringify([2, 3]));
  const activeNow = await getVolunteerBadges(vid);
  assertEq('徽章接口仅返回 active', activeNow.every((b: any) => b.status === 'active'), true);
  const history2 = await getVolunteerBadgeHistory(vid, 1, 50);
  assert('历史接口仍能查到全部授予与收回', history2.events.length > history.events.length);

  console.log('\n== 场景6：低星级徽章在小幅下降时保留 ==');
  // 当前 500 分三星；扣到 320 分仍为三星，徽章不动
  const before = (await getVolunteerBadges(vid)).length;
  adj = await adjustPoints(vid, -180, 'admin', '管理员小幅下调积分但未跨星级线');
  assertEq('等级仍为 3', adj.data!.newLevel, 3);
  assertEq('无徽章收回', adj.data!.revokedBadges.length, 0);
  assertEq('无徽章授予', adj.data!.newBadges.length, 0);
  assertEq('有效徽章数量不变', (await getVolunteerBadges(vid)).length, before);

  console.log('\n== 场景7：服务记录涨分授予徽章 / 爽约扣分收回徽章 ==');
  const v2 = await createVolunteer('徽章联动测试-服务记录');
  const vid2 = v2.data!.id;
  // community_service 权重1.2、评分5加成1.2 => 10h * 10 * 1.2 * 1.2 = 144 分，跨过二星线(100)
  let sr = await createServiceRecord({
    volunteer_id: vid2,
    service_type: 'community_service',
    duration_hours: 10,
    rating: 5,
  });
  assertEq('服务后积分=144', sr.data?.newTotalPoints ?? 0, 144);
  assertEq('服务后等级=2', sr.data?.newLevel ?? 0, 2);
  assertEq('服务授予二星徽章', sr.data!.newBadges.map((b: any) => b.star_level).join(','), '2');
  assertEq('levelUp=true', sr.data!.levelUp, true);
  assertEq('levelDown=false', sr.data!.levelDown, false);

  // 爽约扣 20 分，144 -> 124，仍在二星线以上，徽章保留
  sr = await createServiceRecord({
    volunteer_id: vid2,
    service_type: 'community_service',
    duration_hours: 1,
    rating: 5,
    is_no_show: true,
  });
  assertEq('爽约后积分=124', sr.data!.newTotalPoints, 124);
  assertEq('爽约不收回徽章', sr.data!.revokedBadges.length, 0);

  // 连续爽约 2 次：124 -> 104 -> 84，跌破二星线，收回二星
  await createServiceRecord({
    volunteer_id: vid2, service_type: 'other', duration_hours: 1, rating: 5, is_no_show: true,
  });
  sr = await createServiceRecord({
    volunteer_id: vid2, service_type: 'other', duration_hours: 1, rating: 5, is_no_show: true,
  });
  assertEq('第三次爽约后积分=84', sr.data!.newTotalPoints, 84);
  assertEq('跌破二星线等级=1', sr.data!.newLevel, 1);
  assertEq('爽约收回二星徽章', sr.data!.revokedBadges.map((b: any) => b.star_level).join(','), '2');
  assertEq('levelDown=true', sr.data!.levelDown, true);
  const revokeReason = sr.data!.revokedBadges[0].revoke_reason as string;
  assert('爽约收回原因含爽约扣分来源', /爽约扣分/.test(revokeReason), revokeReason);

  // 再正常服务涨回 100+ 分，重新授予
  sr = await createServiceRecord({
    volunteer_id: vid2, service_type: 'community_service', duration_hours: 10, rating: 5,
  });
  assertEq('再次服务后积分>=100', sr.data!.newTotalPoints >= 100, true);
  assertEq('重新授予二星徽章', sr.data!.newBadges.map((b: any) => b.star_level).join(','), '2');
  const rows2 = await pool.query('SELECT * FROM badges WHERE volunteer_id = $1', [vid2]);
  assertEq('二星仍只有一行', rows2.rows.length, 1);
  assertEq('该行状态为 active', rows2.rows[0].status, 'active');

  console.log(`\n========================================`);
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  console.log(`========================================\n`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
