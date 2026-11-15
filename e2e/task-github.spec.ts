import { expect, test } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
import { githubTaskObjectURL } from '../src/lib/github-task-activity';

test('task GitHub associations are visible in cards and details without changing tasks', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('GitHub Visibility Tester');
  await page
    .getByLabel('Email address')
    .fill(`task-github-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('a-github-visibility-test-password');
  await submitRegistration(page);
  const me = await (await page.request.get('/api/me')).json();
  const workspaceId = me.workspaces[0].id;
  const origin = new URL(page.url()).origin;
  const projectResponse = await page.request.post(`/api/projects?workspaceId=${workspaceId}`, {
    headers: { origin },
    data: { name: 'GitHub visibility fixture' },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const taskResponse = await page.request.post(`/api/tasks?workspaceId=${workspaceId}`, {
    headers: { origin },
    data: { projectId: project.id, title: 'Inspect GitHub activity', status: 'TODO' },
  });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json();
  const sha = '9023d37' + 'a'.repeat(33); // UI fixture, not a live GitHub commit assertion.
  const items = (['COMMIT', 'PULL_REQUEST', 'ISSUE', 'WORKFLOW_RUN'] as const).map((kind, i) => ({
    id: `fixture-${i}`,
    kind,
    key: i ? String(i + 6) : sha,
    repositoryName: 'jameelsikandar/25-react-projects',
    connection: 'connected',
    url: githubTaskObjectURL('jameelsikandar/25-react-projects', kind, i ? String(i + 6) : sha),
    status: [null, 'Merged', 'Open', 'Completed · Success'][i],
    statusSource: 'observation',
    updatedAt: '2026-11-14T12:00:00Z',
    incomplete: false,
  }));
  // Browser-only fixtures. Real association persistence/isolation is covered by DB tests.
  await page.route('**/api/snapshot?**', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.tasks = json.tasks.map((t: { id: string; _count: object }) =>
      t.id === task.id ? { ...t, _count: { ...t._count, githubLinks: 4 } } : t,
    );
    await route.fulfill({ response, json });
  });
  await page.route(`**/api/tasks/${task.id}/github?**`, (route) =>
    route.fulfill({ json: { total: 4, offset: 0, limit: 10, hasMore: false, items } }),
  );
  let taskWrites = 0;
  page.on('request', (r) => {
    if (
      new URL(r.url()).pathname === `/api/tasks/${task.id}` &&
      ['POST', 'PATCH', 'DELETE'].includes(r.method())
    )
      taskWrites++;
  });
  await waitForWorkspace(page, () => page.reload());
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Board', exact: true })
    .click();
  const card = page.locator('.task-card').filter({ hasText: task.title });
  await expect(card.getByLabel('GitHub activity: 4 linked objects', { exact: true })).toBeVisible();
  await card.locator('.task-open').click();
  const dialog = page.getByRole('dialog');
  const activity = dialog.getByRole('region', { name: /GitHub activity/ });
  await activity.scrollIntoViewIfNeeded();
  await expect(activity.getByRole('link')).toHaveCount(4);
  await expect(activity).toContainText('9023d37');
  await expect(activity).toContainText('jameelsikandar/25-react-projects');
  for (const link of await activity.getByRole('link').all()) {
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('href', /^https:\/\/github\.com\//);
  }
  await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await activity.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`task-github-${theme}.png`),
      fullPage: true,
    });
  }
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const grip = card.getByRole('button', { name: `Move ${task.title}`, exact: true });
  await grip.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(1);
  expect(taskWrites).toBe(0);
  const after = await (
    await page.request.get(`/api/tasks/${task.id}?workspaceId=${workspaceId}`)
  ).json();
  expect(after).toMatchObject({
    version: task.version,
    status: task.status,
    assigneeId: task.assigneeId,
    priority: task.priority,
  });
});
