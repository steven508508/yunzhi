/**
 * 版本資訊。升級與回滾時用來確認「現在跑的到底是哪一版」——
 * 沒有這個端點，維運人員只能靠 docker images 的 tag 猜。
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const lastDeploy = await prisma.deploymentRecord
    .findFirst({ orderBy: { startedAt: 'desc' } })
    .catch(() => null);

  return NextResponse.json({
    appVersion: process.env.APP_VERSION ?? 'dev',
    nodeVersion: process.version,
    schemaVersion: lastDeploy?.schemaVersion ?? 'unknown',
    lastDeployment: lastDeploy
      ? {
          action: lastDeploy.action,
          at: lastDeploy.startedAt,
          succeeded: lastDeploy.succeeded,
        }
      : null,
  });
}
