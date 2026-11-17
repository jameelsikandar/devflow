import { expect, test } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
import { healthFixture } from '../tests/github-health-fixture';

test('administrator health is read-only, responsive and explicit about stale/error evidence', async ({
  page,
}) => {
  test.setTimeout(90000); // Existing cold-start journey budget; includes viewport/theme screenshots.
  // Real authentication uses devflow_test; GitHub/health responses are UI fixtures.
  // This test is not worker, provider or server-authorization acceptance.
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('Health UI Tester');
  await page
    .getByLabel('Email address')
    .fill(`health-ui-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('a-health-ui-test-password');
  await submitRegistration(page);
  const me = await (await page.request.get('/api/me')).json();
  const workspaceId = me.workspaces[0].id;
  const response = await page.request.post(`/api/projects?workspaceId=${workspaceId}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { name: 'Health UI fixture' },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  const scope = { workspaceId, projectId: project.id, connectionId: 'ui-health-fixture' };
  let fail = false;
  const writes: string[] = [];
  await page.route('**/api/github**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      writes.push(path);
      return route.fulfill({ status: 405, json: { error: 'UI fixture forbids GitHub writes' } });
    }
    if (path.endsWith('/health'))
      return route.fulfill({
        status: fail ? 503 : 200,
        json: fail
          ? { error: 'private provider diagnostic' }
          : healthFixture('HEALTHY_IDLE', scope),
      });
    if (path === '/api/github/repositories')
      return route.fulfill({
        json: [{ id: scope.connectionId, repositoryFullName: 'fixture/repo' }],
      });
    if (path.endsWith('/processing'))
      return route.fulfill({
        json: {
          counts: {},
          items: [],
          total: 0,
          hasMore: false,
          enrichmentEnabled: false,
          disconnected: false,
        },
      });
    if (path.endsWith('/activity'))
      return route.fulfill({ json: { items: [], total: 0, hasMore: false } });
    return route.fulfill({
      json: { configured: false, connected: false, repositories: [], commits: [], pulls: [] },
    });
  });
  await waitForWorkspace(page, () => page.reload());
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Integrations' })
    .getByRole('button', { name: 'GitHub', exact: true })
    .click();
  const health = page.getByRole('region', { name: 'Operational health', exact: true });
  await expect(health).toContainText('Healthy idle');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await health.scrollIntoViewIfNeeded();
      await expect(
        health.getByRole('button', { name: 'Refresh operational health' }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`github-health-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  const refresh = health.getByRole('button', { name: 'Refresh operational health' });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  fail = true;
  await refresh.press('Enter');
  await expect(health.getByRole('alert')).toContainText('Could not refresh operational health');
  await expect(health).toContainText('Last observed: Healthy idle');
  await expect(health).not.toContainText('private provider diagnostic');
  fail = false;
  await refresh.click();
  await expect(health.getByRole('alert')).toHaveCount(0);
  expect(writes).toEqual([]);
});
