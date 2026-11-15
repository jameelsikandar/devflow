import 'dotenv/config';
import { PrismaClient, type Priority, type Status } from '@prisma/client';
import { hashPassword } from '../src/lib/server/crypto';
const db = new PrismaClient();
const titles = [
  'Design the new onboarding experience',
  'Build workspace invitation flow',
  'Add keyboard shortcuts to command menu',
  'Implement notification preferences',
  'Polish the project overview cards',
  'Set up API request tracing',
  'Review authentication session expiry',
  'Build reusable empty states',
  'Create activity feed endpoint',
  'Improve mobile navigation',
  'Add repository linking to projects',
  'Write task authorization tests',
  'Refine the design token system',
  'Implement optimistic task updates',
  'Document local development setup',
  'Add pagination to repository list',
  'Review database query performance',
  'Build task comment composer',
  'Set up production health checks',
  'Test drag and drop accessibility',
  'Add completion trend chart',
  'Handle connection retry states',
  'Create project archive flow',
  'Ship the new settings page',
  'Add loading skeleton components',
  'Improve search relevance',
  'Review sprint acceptance criteria',
  'Set up CI verification workflow',
  'Implement label filters',
  'Polish login and registration forms',
];
async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 12)
    throw new Error('Set SEED_PASSWORD to at least 12 characters. No default password is shipped.');
  const emails = [
    'alex@devflow.local',
    'jordan@devflow.local',
    'sam@devflow.local',
    'riley@devflow.local',
  ];
  const names = ['Alex Morgan', 'Jordan Lee', 'Sam Rivera', 'Riley Chen'];
  const users = [];
  const passwordHash = await hashPassword(password);
  for (let i = 0; i < names.length; i++)
    users.push(
      await db.user.upsert({
        where: { email: emails[i] },
        update: {},
        create: { name: names[i], email: emails[i], passwordHash },
      }),
    );
  // Stable identifiers make re-running seeds safe without deleting user-created records.
  const workspace = await db.workspace.upsert({
    where: { id: 'seed-workspace' },
    update: {},
    create: { id: 'seed-workspace', name: 'Acme Studio' },
  });
  for (let i = 0; i < users.length; i++)
    await db.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: users[i].id } },
      update: {},
      create: {
        workspaceId: workspace.id,
        userId: users[i].id,
        role: i === 0 ? 'OWNER' : i === 1 ? 'ADMIN' : 'MEMBER',
        lastSeenAt: new Date(0),
      },
    });
  const labels = [];
  for (const [name, color] of [
    ['Feature', '#bba2f6'],
    ['Design', '#87b5df'],
    ['Bug', '#ed9696'],
    ['Engineering', '#93bca4'],
    ['Improvement', '#d4b77e'],
  ])
    labels.push(
      await db.label.upsert({
        where: { workspaceId_name: { workspaceId: workspace.id, name } },
        update: {},
        create: { workspaceId: workspace.id, name, color },
      }),
    );
  const projects = [];
  for (const [id, name, description, color] of [
    [
      'seed-platform',
      'Platform redesign',
      'A thoughtful refresh of the experience, from the first hello to the daily flow.',
      '#bba2f6',
    ],
    ['seed-api', 'Developer API', 'A reliable foundation for the things we build next.', '#89b5d6'],
    ['seed-system', 'Design system', 'Consistent by design. Beautiful in every detail.', '#d6b282'],
  ])
    projects.push(
      await db.project.upsert({
        where: { id },
        update: {},
        create: { id, workspaceId: workspace.id, name, description, color },
      }),
    );
  const statuses: Status[] = ['IN_PROGRESS', 'TODO', 'IN_REVIEW', 'BACKLOG', 'DONE'];
  const priorities: Priority[] = ['HIGH', 'MEDIUM', 'HIGH', 'LOW', 'MEDIUM', 'URGENT'];
  for (let i = 0; i < titles.length; i++) {
    const status = statuses[i % 5];
    const createdAt = new Date(Date.now() - (8 + (i % 6)) * 86400000);
    const completedAt = status === 'DONE' ? new Date(Date.now() - (i % 7) * 86400000) : null;
    const task = await db.task.upsert({
      where: { id: `seed-task-${i + 1}` },
      update: {},
      create: {
        id: `seed-task-${i + 1}`,
        projectId: projects[i % 3].id,
        title: titles[i],
        description: `## Context\n${titles[i]} is part of our next product milestone. Keep the implementation focused and accessible.\n\n## Acceptance criteria\n• Works across desktop and mobile\n• Includes helpful loading and error states\n• Verified with relevant automated checks`,
        status,
        priority: priorities[i % 6],
        assigneeId: users[i % 4].id,
        dueDate: new Date(Date.now() + ((i % 8) - 2) * 86400000),
        position: (Math.floor(i / 5) + 1) * 1024,
        createdAt,
        completedAt,
        labels: { create: [{ labelId: labels[i % labels.length].id }] },
      },
    });
    if (i < 9) {
      await db.taskActivity.upsert({
        where: { id: `seed-activity-${i}` },
        update: {},
        create: {
          id: `seed-activity-${i}`,
          workspaceId: workspace.id,
          taskId: task.id,
          actorId: users[i % 4].id,
          message: `${
            status === 'DONE'
              ? 'completed'
              : status === 'IN_REVIEW'
                ? 'requested a review for'
                : 'made progress on'
          } ${task.title}`,
          createdAt: new Date(Date.now() - (i + 1) * 37 * 60000),
        },
      });
    }
    if (i < 5)
      await db.taskComment.upsert({
        where: { id: `seed-comment-${i}` },
        update: {},
        create: {
          id: `seed-comment-${i}`,
          taskId: task.id,
          authorId: users[(i + 1) % 4].id,
          body: 'I’ve reviewed the approach. Let’s keep the first iteration focused, then revisit the details together.',
        },
      });
  }
  console.log(
    'Seeded Acme Studio: 4 users, 3 projects, 30 tasks. Sign in as alex@devflow.local with your SEED_PASSWORD. Existing passwords are not changed by re-seeding.',
  );
}
main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
