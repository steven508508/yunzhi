/**
 * 從既有作答重建能力快照（指令列版本）。
 *
 *   node apps/web/scripts/rebuild-ability.mjs --tenant <租戶 id> [--class <班級 id>]
 *   node apps/web/scripts/rebuild-ability.mjs --tenant <租戶 id> --dry-run
 *
 * # 什麼時候要用它
 *
 * 快照是衍生資料：計分完成時會自動更新（見 lib/scoring.ts）。這支腳本
 * 補的是自動更新走不到的那兩種情況：
 *
 *   **一、第一次上線。** 能力分析是後來才接上去的，而作答記錄可能
 *   已經累積了一整個學期。不重建的話，班級的弱點分析要等下一次考試
 *   才開始有東西——而在那之前每一頁都寫著「還沒有資料」，
 *   看的人會以為功能壞了。
 *
 *   **二、剛把題目標上知識點。** 標註不會回頭改動已經算過的快照，
 *   因為那些學生近期不會再被計分一次。
 *
 * # 與網頁上那顆按鈕的關係
 *
 * 一般情況請用網頁：班級能力分析頁上的「重建快照」（管理員還可以
 * 重建整個補習班）。那條路不必知道租戶 id，也會寫稽核。
 *
 * 這支是給**還沒有人登入得進去**的時候用的——剛升級完、或者要在
 * 部署腳本裡順手跑一次。租戶 id 可以這樣查：
 *
 *   ./deploy/scripts/db-shell.sh -c 'SELECT id,name FROM tenants'
 *
 * # 為什麼一定要給租戶 id
 *
 * 因為這支腳本**不跨租戶**。RLS 之下沒有租戶脈絡就查不到任何一列
 * （fail closed），而跨租戶的逃生口只留給背景工作者與遷移腳本
 * （見 tools/tenancy.mjs 的 CROSS_TENANT_ALLOWED）。一支重算腳本
 * 沒有理由拿到那把鑰匙。
 */
import { PrismaClient } from '@prisma/client';

import { rebuildAbility } from '../lib/ability.mjs';
import { tenantScoped } from '../lib/prismaClient.mjs';
import { withTenant } from '../lib/tenantContext.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
const has = (name) => process.argv.includes(`--${name}`);

const USAGE = `用法：
  node apps/web/scripts/rebuild-ability.mjs --tenant <租戶 id> [--class <班級 id>] [--dry-run]

租戶 id 可以用 ./deploy/scripts/db-shell.sh -c 'SELECT id,name FROM tenants' 查。
一般情況請改用網頁上的「重建快照」，那條路不必知道租戶 id。`;

async function main() {
  const tenantId = arg('tenant') ?? process.env.TENANT_ID ?? '';
  if (!tenantId) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const classId = arg('class');
  const dryRun = has('dry-run');

  const prisma = tenantScoped(new PrismaClient());
  try {
    await withTenant(tenantId, async () => {
      // 租戶脈絡設錯（打錯 id）的症狀是「什麼都查不到」，而那與
      // 「這家補習班還沒有學生」長得一模一樣。先確認一次。
      const tenant = await prisma.tenant.findFirst({ where: { id: tenantId } });
      if (!tenant) {
        console.error(`查不到租戶 ${tenantId}。id 打錯了，或者這個資料庫裡沒有這一家。`);
        console.error(USAGE);
        process.exitCode = 2;
        return;
      }

      const students = classId
        ? await prisma.classMembership.findMany({
            where: { classId, role: 'STUDENT', leftAt: null },
            select: { userId: true },
          })
        : await prisma.user.findMany({
            // 老師自己試考的那幾份不進能力分析，與班級統計同一條規則。
            where: { systemRole: 'STUDENT', deletedAt: null },
            select: { id: true },
          });
      const userIds = students.map((s) => ('userId' in s ? s.userId : s.id));

      console.log(`租戶：${tenant.name}`);
      console.log(`範圍：${classId ? `班級 ${classId}` : '全部學生'}　共 ${userIds.length} 位`);
      if (userIds.length === 0) {
        console.log('沒有學生，不必重建。');
        return;
      }
      if (dryRun) {
        console.log('（--dry-run，不寫入）');
        return;
      }

      const started = Date.now();
      const result = await rebuildAbility(prisma, {
        tenantId,
        userIds,
        onProgress: (done, total) => {
          // 兩百位學生要跑一陣子。沒有進度的話，操作的人會以為它當掉了
          // 而按 Ctrl+C——而中斷會留下一半新一半舊的快照。
          if (done % 20 === 0 || done === total) {
            process.stdout.write(`\r  ${done}/${total}`);
          }
        },
      });
      process.stdout.write('\n');

      console.log(
        `完成：${result.users} 位學生、寫入 ${result.points} 個知識點、` +
          `清掉 ${result.removed} 筆已經沒有證據的快照、` +
          `耗時 ${Math.round((Date.now() - started) / 1000)} 秒`,
      );
      if (result.failures.length) {
        // 一位失敗不會讓整批停住（見 rebuildAbility），但一定要印出來：
        // 沒印的話，那幾位學生的分析會停在舊的數字而沒有人知道。
        console.error(`有 ${result.failures.length} 位算不出來：`);
        for (const f of result.failures.slice(0, 20)) {
          console.error(`  · ${f.userId}：${f.error}`);
        }
        process.exitCode = 1;
      }
    });
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error('重建失敗：', e);
  process.exit(1);
});
