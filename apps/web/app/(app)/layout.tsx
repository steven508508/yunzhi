import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!user) redirect('/login');
  // 初始密碼會出現在設定檔與備份中，不該長期有效
  if (user.mustChangePassword) redirect('/password?first=1');
  return <>{children}</>;
}
