import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createVolunteer, getVolunteerSummary } from '../services/volunteerManager';
import { createServiceRecord } from '../services/volunteerService';
import { adjustPoints } from '../services/adminService';
import { createComplaint, handleComplaint } from '../services/complaintService';
import { getVolunteerBadges, getVolunteerBadgeHistory } from '../services/badgeService';
import { getPointsRanking } from '../services/rankingService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  志愿者积分与信用评估系统 - 验证用例');
  console.log('  测试场景: 徽章随等级收回与重新授予');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建志愿者 ---');
    const volunteerResult = await createVolunteer('测试志愿者-徽章收回', '13900000099', 'badge@example.com');
    assert('志愿者创建成功', volunteerResult.success && !!volunteerResult.data, '志愿者创建失败', volunteerResult);
    const volunteerId = volunteerResult.data?.id;

    if (!volunteerId) {
      console.log('\n⚠️  志愿者创建失败，无法继续测试');
      return;
    }

    console.log('\n--- 用例1: 积分升到300分(level 3)，获得二星、三星徽章 ---');
    const upResult = await adjustPoints(volunteerId, 300, 'admin-test', '测试加分');
    assert('加分成功', upResult.success === true, '加分失败', upResult);
    assert('等级升为3', upResult.data?.newLevel === 3, `期望level 3，实际${upResult.data?.newLevel}`);
    assert(
      '授予2枚徽章(二星+三星)',
      Array.isArray(upResult.data?.newBadges) && upResult.data.newBadges.length === 2,
      `期望2枚新徽章，实际${upResult.data?.newBadges?.length}`,
      upResult.data?.newBadges
    );

    let activeBadges = await getVolunteerBadges(volunteerId);
    assert('当前有效徽章为2枚', activeBadges.length === 2, `期望2枚，实际${activeBadges.length}`);

    console.log('\n--- 用例2: 管理员扣到150分(level 2)，三星收回、二星保留 ---');
    const downResult = await adjustPoints(volunteerId, -150, 'admin-test', '测试扣分');
    assert('扣分成功', downResult.success === true, '扣分失败', downResult);
    assert('等级降为2', downResult.data?.newLevel === 2, `期望level 2，实际${downResult.data?.newLevel}`);
    assert(
      '收回1枚徽章(三星)',
      Array.isArray(downResult.data?.revokedBadges) && downResult.data.revokedBadges.length === 1
        && downResult.data.revokedBadges[0].star_level === 3,
      '收回徽章不符合预期',
      downResult.data?.revokedBadges
    );
    assert(
      '收回记录含收回时间',
      !!downResult.data?.revokedBadges?.[0]?.revoked_at,
      'revoked_at 为空',
      downResult.data?.revokedBadges?.[0]
    );
    assert(
      '收回记录含收回原因',
      typeof downResult.data?.revokedBadges?.[0]?.revoke_reason === 'string'
        && downResult.data.revokedBadges[0].revoke_reason.includes('管理员调整'),
      'revoke_reason 不符合预期',
      downResult.data?.revokedBadges?.[0]
    );

    activeBadges = await getVolunteerBadges(volunteerId);
    assert(
      '低星级徽章保留(仅剩二星)',
      activeBadges.length === 1 && activeBadges[0].star_level === 2,
      `期望仅剩二星，实际${JSON.stringify(activeBadges.map(b => b.star_level))}`
    );

    console.log('\n--- 用例3: 投诉处理扣分至0分(level 1)，二星也被收回 ---');
    const complaintResult = await createComplaint(volunteerId, 'misconduct', '测试投诉-严重违规');
    assert('投诉创建成功', complaintResult.success === true, '投诉创建失败', complaintResult);
    const complaintId = complaintResult.data?.id;

    if (!complaintId) {
      console.log('\n⚠️  投诉创建失败，无法继续测试');
      return;
    }

    const handleResult = await handleComplaint(complaintId, 'resolve', 'admin-test', '情况属实，严肃处理', 5);
    assert('投诉处理成功', handleResult.success === true, '投诉处理失败', handleResult);
    assert('积分扣至0', handleResult.data?.newTotalPoints === 0, `期望0分，实际${handleResult.data?.newTotalPoints}`);
    assert('等级降为1', handleResult.data?.newLevel === 1, `期望level 1，实际${handleResult.data?.newLevel}`);
    assert(
      '收回1枚徽章(二星)',
      Array.isArray(handleResult.data?.revokedBadges) && handleResult.data.revokedBadges.length === 1
        && handleResult.data.revokedBadges[0].star_level === 2,
      '收回徽章不符合预期',
      handleResult.data?.revokedBadges
    );
    assert(
      '收回原因记录为投诉处理',
      (handleResult.data?.revokedBadges?.[0]?.revoke_reason || '').includes('投诉处理扣分'),
      'revoke_reason 不符合预期',
      handleResult.data?.revokedBadges?.[0]
    );

    activeBadges = await getVolunteerBadges(volunteerId);
    assert('有效徽章已清空', activeBadges.length === 0, `期望0枚，实际${activeBadges.length}`);

    const summaryResult = await getVolunteerSummary(volunteerId);
    assert(
      '详情汇总只显示有效徽章(0枚)',
      summaryResult.success === true && summaryResult.data?.badges?.length === 0,
      `期望summary中0枚徽章，实际${summaryResult.data?.badges?.length}`
    );

    console.log('\n--- 用例4: 历史记录可查询授予与收回 ---');
    let history = await getVolunteerBadgeHistory(volunteerId);
    assert('历史共2条(授予2条，收回为原行更新)', history.length === 2, `期望2条，实际${history.length}`, history.map(h => ({ star: h.star_level, revoked: !!h.revoked_at })));
    assert(
      '历史中2条已收回且带原因',
      history.filter(h => h.revoked_at && h.revoke_reason).length === 2,
      '已收回记录数量或字段不符合预期',
      history.map(h => ({ star: h.star_level, revoked_at: h.revoked_at, reason: h.revoke_reason }))
    );

    console.log('\n--- 用例5: 积分涨回300分，重新授予且同一星级不重复 ---');
    const reUpResult = await adjustPoints(volunteerId, 300, 'admin-test', '恢复加分');
    assert('恢复加分成功', reUpResult.success === true, '加分失败', reUpResult);
    assert('等级回到3', reUpResult.data?.newLevel === 3, `期望level 3，实际${reUpResult.data?.newLevel}`);
    assert(
      '重新授予2枚徽章',
      Array.isArray(reUpResult.data?.newBadges) && reUpResult.data.newBadges.length === 2,
      `期望2枚新徽章，实际${reUpResult.data?.newBadges?.length}`,
      reUpResult.data?.newBadges
    );

    activeBadges = await getVolunteerBadges(volunteerId);
    const starLevels = activeBadges.map(b => b.star_level).sort();
    assert('有效徽章恢复为2枚', activeBadges.length === 2, `期望2枚，实际${activeBadges.length}`);
    assert(
      '同一星级只有一份有效徽章',
      new Set(starLevels).size === starLevels.length,
      '存在重复星级的有效徽章',
      starLevels
    );

    history = await getVolunteerBadgeHistory(volunteerId);
    assert(
      '历史累计4条(首次授予2条已收回+重新授予2条有效)',
      history.length === 4 && history.filter(h => h.revoked_at).length === 2,
      `期望4条历史/2条收回，实际${history.length}条/${history.filter(h => h.revoked_at).length}条收回`
    );

    console.log('\n--- 用例6: 爽约扣分降级，徽章同步收回 ---');
    const noShowResult = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'community_service',
      duration_hours: 2,
      rating: 3,
      is_no_show: true,
    });
    assert('爽约记录创建成功', noShowResult.success === true, '创建失败', noShowResult);
    assert('爽约后积分280', noShowResult.data?.newTotalPoints === 280, `期望280分，实际${noShowResult.data?.newTotalPoints}`);
    assert(
      '爽约收回三星徽章',
      Array.isArray(noShowResult.data?.revokedBadges) && noShowResult.data.revokedBadges.length === 1
        && noShowResult.data.revokedBadges[0].star_level === 3
        && (noShowResult.data.revokedBadges[0].revoke_reason || '').includes('爽约'),
      '爽约收回徽章不符合预期',
      noShowResult.data?.revokedBadges
    );

    activeBadges = await getVolunteerBadges(volunteerId);
    assert(
      '爽约后仅剩二星有效徽章',
      activeBadges.length === 1 && activeBadges[0].star_level === 2,
      `期望仅剩二星，实际${JSON.stringify(activeBadges.map(b => b.star_level))}`
    );

    console.log('\n--- 用例7: 排行榜不受影响 ---');
    const rankingResult = await getPointsRanking(100);
    assert('积分排行榜查询成功', rankingResult.success === true && Array.isArray(rankingResult.data), '排行榜查询失败', rankingResult);

    console.log('\n========================================');
    const passed = testResults.filter(t => t.passed).length;
    const failed = testResults.filter(t => !t.passed).length;
    console.log(`  测试结果: ${passed} 通过, ${failed} 失败`);
    console.log('========================================\n');

    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('测试执行异常:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

runTests();
