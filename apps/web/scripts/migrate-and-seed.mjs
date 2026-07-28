/**
 * 資料庫遷移與初始化。
 *
 * 由 compose 的 migrate service 執行一次，web 依賴它成功完成。
 * 獨立成一個服務而不是塞進 web 的 entrypoint，是為了讓多個
 * web replica 不會同時跑 migration 互相打架。
 */
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { tenantScoped } from '../lib/prismaClient.mjs';
import { withoutTenantScope } from '../lib/tenantContext.mjs';
import bcrypt from 'bcryptjs';

const SCHEMA = 'packages/db/schema.prisma';

function run(cmd, args) {
  console.log(`→ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

async function main() {
  // 建租戶本身、跑遷移、塞種子——這支腳本比租戶更早存在，
  // 所以它必須跨租戶。
  return withoutTenantScope('遷移與種子：這支腳本比租戶本身更早執行', mainScoped);
}

async function mainScoped() {
  console.log('── 資料庫遷移 ──────────────────────────────');
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', SCHEMA]);

  const prisma = tenantScoped(new PrismaClient());
  try {
    console.log('── 初始資料 ────────────────────────────────');

    const tenantName = process.env.TENANT_NAME || '雲端智學';
    let tenant = await prisma.tenant.findFirst();
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { name: tenantName } });
      console.log(`  建立租戶：${tenant.name}`);
    } else {
      console.log(`  租戶已存在：${tenant.name}`);
    }

    // 學年度。台灣的學年從 8 月起算，所以 1 至 7 月屬於前一個學年。
    const now = new Date();
    const rocYear = now.getFullYear() - 1911 - (now.getMonth() + 1 < 8 ? 1 : 0);
    const yearName = `${rocYear}學年度`;
    const existingYear = await prisma.academicYear.findFirst({
      where: { tenantId: tenant.id, name: yearName },
    });
    if (!existingYear) {
      await prisma.academicYear.create({
        data: {
          tenantId: tenant.id,
          name: yearName,
          startDate: new Date(Date.UTC(rocYear + 1911, 7, 1)),
          endDate: new Date(Date.UTC(rocYear + 1912, 6, 31)),
          isCurrent: true,
        },
      });
      console.log(`  建立學年度：${yearName}`);
    }

    // 初始管理員。只在不存在時建立 —— 改 .env 不會覆蓋既有帳號，
    // 否則升級時會意外把管理員密碼重設回設定檔裡的舊值。
    const username = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const existingAdmin = await prisma.user.findFirst({
      where: { tenantId: tenant.id, username },
    });

    if (!existingAdmin) {
      if (!password) {
        console.error('  ✗ 沒有既有管理員，且 BOOTSTRAP_ADMIN_PASSWORD 是空的。');
        console.error('    請執行 ./deploy/scripts/gen-secrets.sh 產生一組密碼。');
        process.exit(1);
      }
      await prisma.user.create({
        data: {
          tenantId: tenant.id,
          username,
          email: process.env.BOOTSTRAP_ADMIN_EMAIL || null,
          displayName: '系統管理員',
          passwordHash: await bcrypt.hash(password, 12),
          systemRole: 'SYS_ADMIN',
          status: 'ACTIVE',
          // 強制更換：.env 裡的密碼會留在檔案與備份中，
          // 不該長期作為有效憑證。
          mustChangePassword: true,
        },
      });
      console.log(`  建立管理員：${username}（首次登入須更換密碼）`);
    } else {
      console.log(`  管理員已存在：${username}`);
    }

    // 稽核記錄只能新增不能修改，靠資料庫觸發器強制而非只靠應用層。
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION yunzhi_audit_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '稽核記錄不可修改或刪除（audit_logs 為 append-only）';
      END; $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER audit_logs_immutable
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION yunzhi_audit_immutable();
    `);
    console.log('  稽核記錄不可竄改觸發器已就緒');

    await prisma.deploymentRecord.create({
      data: {
        appVersion: process.env.APP_VERSION || 'dev',
        schemaVersion: 'migrate-deploy',
        action: 'migrate',
        finishedAt: new Date(),
        succeeded: true,
      },
    });

    console.log('── 完成 ────────────────────────────────────');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('遷移失敗：', e.message);
  process.exit(1);
});
