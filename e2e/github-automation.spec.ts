import { expect, test } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';

test('automation enable confirmation, source inspection and refreshed Kanban machine activity', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('Automation UI tester');
  await page
    .getByLabel('Email address')
    .fill(`automation-ui-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('automation-browser-test-password');
  await submitRegistration(page);
  const me = await (await page.request.get('/api/me')).json();
  const workspaceId = me.workspaces[0].id;
  const headers = { origin: new URL(page.url()).origin };
  const projectResponse = await page.request.post(`/api/projects?workspaceId=${workspaceId}`, {
    headers,
    data: { name: 'Automation UI fixture' },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const response = await page.request.post(`/api/tasks?workspaceId=${workspaceId}`, {
    headers,
    data: { projectId: project.id, title: 'Automation status fixture', status: 'TODO' },
  });
  expect(response.status()).toBe(201);
  const task = await response.json();
  await waitForWorkspace(page, () => page.reload());
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'GitHub workflow settings for Automation UI fixture' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Rule name', { exact: true }).fill('PR merged → Done');
  await dialog.getByRole('button', { name: 'Create disabled rule' }).click();
  const rules = dialog.locator('.workflow-rule-list').first();
  await expect(rules).toContainText('Disabled');
  page.once('dialog', (d) => d.dismiss());
  await rules.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(rules).toContainText('Disabled');
  page.once('dialog', (d) => d.accept());
  await rules.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(rules).toContainText('Enabled · automation');
  // UI-only fixtures: real transactional status/activity behavior is tested in PostgreSQL.
  await page.route(`**/api/projects/${project.id}/github-workflows/executions?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'execution-fixture',
            state: 'APPLIED',
            reason: 'STATUS_CHANGED',
            attempts: 1,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            ruleName: 'PR merged → Done',
            ruleVersion: 2,
            taskId: task.id,
            taskReference: `DEV-${String(task.number).padStart(3, '0')}`,
            taskTitle: task.title,
            expectedTaskVersion: 0,
            previousStatus: 'TODO',
            targetStatus: 'DONE',
            repository: 'owner/repo',
            prNumber: '2',
            prUrl: 'https://github.com/owner/repo/pull/2',
            disconnected: false,
          },
        ],
        total: 1,
        offset: 0,
        hasMore: false,
      },
    }),
  );
  await dialog.getByRole('button', { name: 'Refresh execution history' }).click();
  const history = dialog.getByRole('region', { name: 'Automation execution history' });
  await expect(history).toContainText('applied');
  await expect(history.getByRole('link', { name: 'View PR #2' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const message = `moved DEV-${String(task.number).padStart(3, '0')} from Todo to Done · PR #2 · PR merged → Done (v2)`;
  await page.route('**/api/snapshot?**', async (route) => {
    const r = await route.fetch();
    const json = await r.json();
    json.tasks = json.tasks.map((t: { id: string }) =>
      t.id === task.id ? { ...t, status: 'DONE', version: 1 } : t,
    );
    await route.fulfill({ response: r, json });
  });
  await page.route(`**/api/tasks/${task.id}?**`, async (route) => {
    const r = await route.fetch();
    const json = await r.json();
    await route.fulfill({
      response: r,
      json: {
        ...json,
        status: 'DONE',
        version: 1,
        activities: [
          {
            id: 'automation-ui-event',
            actor: null,
            source: 'GITHUB_AUTOMATION',
            message,
            createdAt: new Date().toISOString(),
          },
          ...json.activities,
        ],
      },
    });
  });
  await waitForWorkspace(page, () => page.reload());
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Board', exact: true })
    .click();
  const card = page
    .getByRole('region', { name: 'Done', exact: true })
    .locator('.task-card')
    .filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.locator('.task-open').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.locator('.task-history')).toContainText('GitHub automation');
  await expect(page.locator('.task-history')).toContainText(message);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((v) => {
      document.documentElement.dataset.theme = v;
    }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`automation-${theme}.png`),
      fullPage: true,
    });
  }
  // Browser interception never changes the actual isolated fixture task.
  expect(
    (await (await page.request.get(`/api/tasks/${task.id}?workspaceId=${workspaceId}`)).json())
      .version,
  ).toBe(task.version);
});
