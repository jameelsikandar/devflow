import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/server/auth';
import { DevFlow } from '@/components/devflow';
export const dynamic = 'force-dynamic';
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    const { invite } = await searchParams;
    redirect(invite ? `/login?invite=${encodeURIComponent(invite)}` : '/login');
  }
  return (
    <DevFlow
      user={{ id: user.id, name: user.name, email: user.email, hasAvatar: !!user.avatarType }}
    />
  );
}
