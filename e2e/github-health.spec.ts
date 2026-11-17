import { expect, test } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
import { healthFixture } from '../tests/github-health-fixture';
import { retentionFixture } from '../tests/github-retention-fixture';

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
  let revalidations = 0;
  let retentionReads = 0;
  let workerState: 'HEALTHY_IDLE' | 'UNAVAILABLE' = 'HEALTHY_IDLE';
  let authorizationRejected = true;
  let retentionIncomplete = false;
  let retentionFailure = false;
  await page.route('**/api/github**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/revalidate') && route.request().method() === 'POST') {
      revalidations++;
      expect(route.request().postDataJSON()).toEqual({});
      return route.fulfill({
        json: {
          scope,
          checkedAt: new Date().toISOString(),
          authorizationSource: 'REQUESTING_ADMIN',
          state: authorizationRejected ? 'AUTHORIZATION_REJECTED' : 'VALID',
          code: authorizationRejected ? 'AUTHORIZATION_REJECTED' : 'ACCESS_VALID',
          retryAt: null,
          retrySource: null,
        },
      });
    }
    if (route.request().method() !== 'GET') {
      writes.push(path);
      return route.fulfill({ status: 405, json: { error: 'UI fixture forbids GitHub writes' } });
    }
    if (path.endsWith('/retention') && route.request().method() === 'GET') {
      retentionReads++;
      const days = Number(new URL(route.request().url()).searchParams.get('days')) as 7 | 30 | 90;
      if (retentionFailure)
        return route.fulfill({ status: 503, json: { error: 'private report timeout' } });
      const report = retentionFixture(days);
      if (retentionIncomplete) {
        report.complete = false;
        Object.assign(report.categories[0], {
          complete: false,
          scannedAtLeast: 10001,
          total: null,
          older: null,
          potentiallyEligible: null,
          preservedOlder: null,
          dependencyProtectedOlder: null,
          oldestAt: null,
          newestAt: null,
        });
      }
      return route.fulfill({
        json: {
          ...report,
          scope: { workspaceId, projectId: project.id, archived: false },
        },
      });
    }
    if (path.endsWith('/health'))
      return route.fulfill({
        status: fail ? 503 : 200,
        json: fail ? { error: 'private provider diagnostic' } : healthFixture(workerState, scope),
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
      await expect(page.locator('body')).toHaveCSS('font-size', '15px');
      await expect(page.locator('.nav-item').first()).toHaveCSS('font-size', '14px');
      await expect(health.locator('p').first()).toHaveCSS('font-size', '13px');
      await expect(health.getByRole('button', { name: 'Refresh operational health' })).toHaveCSS(
        'font-size',
        '14px',
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`github-health-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  // Text resizing is distinct from native browser zoom. Verify rem-based text
  // scales without a forced pixel root; screenshots remain local test artifacts.
  await page.setViewportSize({ width: 390, height: 900 });
  try {
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect(health.locator('p').first()).toHaveCSS('font-size', '26px');
    await health.getByRole('button', { name: 'Refresh operational health' }).focus();
    await expect(health.getByRole('button', { name: 'Refresh operational health' })).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath('github-health-text-resize-200.png'),
      fullPage: true,
    });
  } finally {
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('font-size');
    });
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
  expect(revalidations).toBe(0);
  workerState = 'UNAVAILABLE';
  await refresh.click();
  await expect(health).toContainText('No fresh continuous-worker signal');
  workerState = 'HEALTHY_IDLE';
  await refresh.click();
  await expect(health).toContainText('Healthy idle');
  const revalidation = page.getByRole('region', { name: 'Connection revalidation', exact: true });
  await revalidation.getByRole('button', { name: 'Revalidate GitHub access', exact: true }).click();
  await expect(revalidation).toContainText('Authorization rejected');
  expect(revalidations).toBe(1);
  authorizationRejected = false;
  await revalidation.getByRole('button', { name: 'Revalidate GitHub access', exact: true }).click();
  await expect(revalidation).toContainText('Repository access verified');
  await expect(revalidation).toContainText('Your OAuth account only');
  expect(revalidations).toBe(2);
  expect(retentionReads).toBe(0);
  const retention = page.getByRole('region', { name: 'Retention impact report', exact: true });
  await retention.getByRole('button', { name: 'Generate read-only report', exact: true }).click();
  await expect(retention).toContainText('No GitHub operational records');
  expect(retentionReads).toBe(1);
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await retention.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`retention-report-${width}.png`),
      fullPage: true,
    });
  }

  retentionIncomplete = true;
  await retention.getByRole('button', { name: 'Generate read-only report', exact: true }).click();
  await expect(retention).toContainText('Report incomplete');
  await expect(retention).toContainText('analysis not calculated');
  retentionFailure = true;
  await retention.getByRole('button', { name: 'Generate read-only report', exact: true }).click();
  await expect(retention.getByRole('alert')).toContainText('Could not calculate retention impact');
  await expect(retention.locator('table')).toHaveCount(0);
  await expect(retention).not.toContainText('private report timeout');
  retentionFailure = false;
  retentionIncomplete = false;
  await retention.getByRole('button', { name: 'Try retention report again', exact: true }).click();
  await expect(retention).toContainText('No GitHub operational records');
  expect(writes).toEqual([]); // No GitHub resource mutation, enrichment or retry requests.
});
