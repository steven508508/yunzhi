/**
 * 密碼與 session。
 *
 * 兩個安全決定值得說明：
 *
 * 1. **登入失敗計數與鎖定放在資料庫**，不是記憶體。多實例部署時
 *    記憶體計數等於沒有計數——攻擊者輪流打不同實例就繞過了。
 *
 * 2. **帳號不存在與密碼錯誤回傳同一個訊息**，且都跑一次雜湊比對。
 *    否則回應時間會洩漏帳號是否存在，那是列舉學號的入口——
 *    而學號在補習班是可以猜的（連號）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SESSION_COOKIE } from '@/lib/auth';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/**
 * 不存在的帳號也要跑一次比對，讓回應時間一致。
 *
 * **這個字串必須是合法的 bcrypt 雜湊。** 上一版是手打的 62 個字元，
 * 而合法的 bcrypt 雜湊固定 60（`$2a$12$` 加 22 字元 salt 加 31 字元
 * 摘要）。bcryptjs 對格式錯誤的雜湊直接回 false，**完全不做運算**：
 * 實測假雜湊 0.065 ms、真雜湊 335 ms，差五千倍。回應時間就是現成的
 * 「這個帳號存不存在」的神諭，而補習班的學號是連號的。
 *
 * 所以改成在載入時真的算一次。多花約 300 ms 的啟動時間，換掉一個
 * 靜默失效的防護。
 */
const DUMMY_HASH = bcrypt.hashSync(
  randomBytes(24).toString('base64url'),
  BCRYPT_ROUNDS,
);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export type LoginResult =
  | { ok: true; token: string; expires: Date; mustChangePassword: boolean }
  | { ok: false; reason: 'invalid' | 'locked' | 'inactive'; retryAfterMinutes?: number };

export async function login(
  tenantId: string,
  username: string,
  password: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { tenantId, username, deletedAt: null },
  });

  if (!user) {
    // 時間一致化：不存在的帳號也跑一次雜湊
    await bcrypt.compare(password, DUMMY_HASH);
    return { ok: false, reason: 'invalid' };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    return { ok: false, reason: 'locked', retryAfterMinutes: mins };
  }

  if (user.status !== 'ACTIVE') {
    return { ok: false, reason: 'inactive' };
  }

  const valid = user.passwordHash
    ? await bcrypt.compare(password, user.passwordHash)
    : false;

  if (!valid) {
    const failed = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED
          ? new Date(Date.now() + LOCK_MINUTES * 60_000)
          : null,
      },
    });
    await audit(tenantId, 'auth.login_failed', user.id, meta.ip, { failedCount: failed });
    return { ok: false, reason: 'invalid' };
  }

  const token = randomBytes(32).toString('base64url');
  const maxAge = Number(process.env.AUTH_SESSION_MAX_AGE ?? 43200);
  const expires = new Date(Date.now() + maxAge * 1000);

  await prisma.$transaction([
    prisma.session.create({
      data: {
        sessionToken: token,
        userId: user.id,
        expires,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    }),
  ]);

  await audit(tenantId, 'auth.login', user.id, meta.ip);
  return { ok: true, token, expires, mustChangePassword: user.mustChangePassword };
}

export async function logout(token: string) {
  await prisma.session.deleteMany({ where: { sessionToken: token } });
}

/** 立刻登出某個帳號的所有 session。發現代考時要能馬上斷。 */
export async function revokeAllSessions(userId: string) {
  return prisma.session.deleteMany({ where: { userId } });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash) return { ok: false, error: '找不到帳號' };

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return { ok: false, error: '目前的密碼不正確' };

  const problem = checkPasswordStrength(newPassword, user.username);
  if (problem) return { ok: false, error: problem };

  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    return { ok: false, error: '新密碼不能與目前的密碼相同' };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
      },
    }),
    // 改密碼後把其他 session 全部作廢。若密碼是因為外洩而更換，
    // 留著舊 session 等於沒改。
    prisma.session.deleteMany({ where: { userId } }),
  ]);

  await audit(user.tenantId, 'auth.password_changed', userId);
  return { ok: true };
}

/**
 * 密碼強度。刻意不強制大小寫與特殊符號的組合規則——
 * NIST SP 800-63B 已指出那類規則會讓使用者選出可預測的密碼
 * （Password1!）。改為要求長度並排除明顯不安全的選擇。
 */
export function checkPasswordStrength(pw: string, username?: string): string | null {
  if (pw.length < 10) return '密碼至少需要 10 個字元';
  if (pw.length > 200) return '密碼過長';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) {
    return '密碼不能包含帳號';
  }
  const common = ['password', '12345678', 'qwerty', 'abc123', '00000000', 'yunzhi'];
  const lower = pw.toLowerCase();
  if (common.some((c) => lower.includes(c))) return '密碼包含過於常見的字串';
  if (/^(.)\1+$/.test(pw)) return '密碼不能是單一字元重複';
  return null;
}

async function audit(
  tenantId: string,
  action: string,
  actorId: string | null,
  ip?: string,
  // Prisma 的 JSON 欄位型別不接受 Record<string, unknown>（unknown 不保證
  // 可序列化）。用 Prisma.InputJsonValue 而非 any：這裡塞進去的東西
  // 會直接寫進不可竄改的稽核記錄，型別鬆掉的代價是某天寫進一個
  // 序列化失敗的物件，而稽核寫入失敗是被刻意吞掉的。
  metadata?: Prisma.InputJsonObject,
) {
  await prisma.auditLog.create({
    data: { tenantId, category: 'AUTH', action, actorId, actorIp: ip ?? null, metadata: metadata ?? undefined },
  }).catch(() => {
    // 稽核寫入失敗不應該讓登入失敗，但要留下痕跡
    console.error('[audit] 寫入失敗', action);
  });
}

export { SESSION_COOKIE };
