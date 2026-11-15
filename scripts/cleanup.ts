import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
async function main() {
  const now = new Date();
  const [sessions, invites, limits] = await db.$transaction([
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.workspaceInvite.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  console.log({
    expiredSessions: sessions.count,
    expiredInvites: invites.count,
    expiredRateLimits: limits.count,
  });
}
main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error.name);
    process.exitCode = 1;
  });
