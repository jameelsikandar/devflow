import { expect, test } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
test('project workflow definitions persist and never execute task transitions', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('Workflow Administrator');
  await page
    .getByLabel('Email address')
    .fill(`workflow-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('workflow-preview-test-password');
  await submitRegistration(page);
  const me = await (await page.request.get('/api/me')).json();
  const workspaceId = me.workspaces[0].id;
  const headers = { origin: new URL(page.url()).origin };
  const projectResponse = await page.request.post(`/api/projects?workspaceId=${workspaceId}`, {
    headers,
    data: { name: 'Workflow preview project' },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const taskResponse = await page.request.post(`/api/tasks?workspaceId=${workspaceId}`, {
    headers,
    data: { projectId: project.id, title: 'Must remain unchanged', status: 'TODO' },
  });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json();
  await waitForWorkspace(page, () => page.reload());
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'GitHub workflow settings for Workflow preview project',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Rule name', { exact: true }).fill('PR merged → Done');
  await dialog.getByRole('button', { name: 'Create disabled rule', exact: true }).click();
  const rules = dialog.locator('.workflow-rule-list');
  await expect(rules).toContainText('PR merged → Done');
  await expect(rules).toContainText('Disabled');
  page.once('dialog', (d) => d.accept());
  await rules.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(rules).toContainText('Enabled');
  await expect(rules).toContainText('v2');
  await expect(dialog).toContainText('No stored pull request observations');
  await expect(dialog.getByRole('button', { name: 'Preview only', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'View configuration history' }).click();
  await expect(dialog.getByRole('region', { name: 'Rule audit history' })).toContainText(
    'create · v1',
  );
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`workflow-${theme}.png`),
      fullPage: true,
    });
  }
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'GitHub workflow settings for Workflow preview project',
      exact: true,
    })
    .click();
  await expect(rules).toContainText('PR merged → Done');
  page.once('dialog', (d) => d.accept());
  await rules.getByRole('button', { name: 'Delete PR merged → Done', exact: true }).click();
  await expect(dialog).toContainText('No rules yet');
  const after = await (
    await page.request.get(`/api/tasks/${task.id}?workspaceId=${workspaceId}`)
  ).json();
  expect(after).toMatchObject({
    status: task.status,
    version: task.version,
    priority: task.priority,
    assigneeId: task.assigneeId,
    completedAt: task.completedAt,
  });
});
