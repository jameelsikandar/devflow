import { test, expect } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
test('register, plan a roadmap, move a task, comment, search and sign out', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const email = `journey-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('Taylor Builder');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a-safe-journey-password');
  await submitRegistration(page);
  await expect(page.getByRole('heading', { name: /Welcome back, Taylor/ })).toBeVisible();
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('button', { name: 'New project', exact: true }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project name').fill('Launch pad');
  await dialog.getByLabel('Description').fill('Ship a thoughtful developer experience');
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Launch pad Ship a thoughtful/ }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Build the first release');
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveCSS(
    'font-size',
    testInfo.project.name === 'mobile' ? '16px' : '14px',
  );
  await dialog.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('HIGH');
  await expect(dialog.getByRole('combobox', { name: 'Assignee', exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(
    page.locator('.task-table-row').filter({ hasText: 'Build the first release' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Plan the next release');
  await dialog.getByRole('button', { name: /Create task/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.locator('.task-table-row').filter({ hasText: 'Plan the next release' }),
  ).toBeVisible();
  const navigate = async (name: string | RegExp) => {
    await openAppNavigation(page);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name })
      .click();
  };
  await navigate('Roadmap');
  await expect(page.getByRole('heading', { name: 'Task schedule', exact: true })).toBeVisible();
  await expect(page.locator('.roadmap-row').first()).toHaveCSS('height', '54px');
  await expect(page.locator('.roadmap-task-label strong').first()).toHaveCSS('font-size', '15px');
  await page.locator('.roadmap-task-label').filter({ hasText: 'Build the first release' }).click();
  await page.getByLabel('Start date (UTC)', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Due date (UTC)', { exact: true }).fill('2026-11-03');
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Reschedule Build the first release', exact: true }),
  ).toHaveCount(1);
  await page.locator('.roadmap-task-label').filter({ hasText: 'Plan the next release' }).click();
  await page.getByLabel('Mark as a milestone').check();
  await page.getByLabel('Start date (UTC)', { exact: true }).fill('2026-11-05');
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(page.locator('.roadmap-bar-milestone')).toHaveCount(1);
  const predecessor = page.getByLabel('Predecessor task');
  const firstId = await predecessor
    .locator('option')
    .filter({ hasText: 'Build the first release' })
    .getAttribute('value');
  await predecessor.selectOption(firstId!);
  const successor = page.getByLabel('Successor task');
  const nextId = await successor
    .locator('option')
    .filter({ hasText: 'Plan the next release' })
    .getAttribute('value');
  await successor.selectOption(nextId!);
  await page.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('.roadmap-dependencies li')).toHaveCount(1);
  await predecessor.selectOption(nextId!);
  await successor.selectOption(firstId!);
  await page.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('.roadmap-editor .form-error')).toContainText('circular');
  await page
    .getByRole('button', {
      name: 'Remove dependency from Build the first release to Plan the next release',
      exact: true,
    })
    .click();
  await expect(page.locator('.roadmap-dependencies li')).toHaveCount(0);
  await predecessor.selectOption(firstId!);
  await successor.selectOption(nextId!);
  await page.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('.roadmap-dependencies li')).toHaveCount(1);
  await page.getByLabel('Timeline zoom').selectOption('day');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await waitForWorkspace(page, () => page.reload());
  await navigate('Roadmap');
  await expect(page.locator('.roadmap-dependencies li')).toHaveCount(1);
  await expect(page.locator('.roadmap-bar-milestone')).toHaveCount(1);
  await expect(page.locator('.roadmap-connector')).toHaveCount(1);
  await page.getByLabel('Timeline zoom').selectOption('day');
  const grip = page.getByRole('button', {
    name: 'Reschedule Build the first release',
    exact: true,
  });
  await grip.scrollIntoViewIfNeeded();
  if (testInfo.project.name === 'mobile') {
    await grip.focus();
    await grip.press('Space');
    for (let i = 0; i < 4; i++) await grip.press('ArrowRight');
    await grip.press('Space');
  } else {
    const bounds = await grip.boundingBox();
    expect(bounds).not.toBeNull();
    const x = bounds!.x + bounds!.width / 2;
    const y = bounds!.y + bounds!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 96, y, { steps: 12 });
    await page.mouse.up();
  }
  await expect(page.getByLabel('Start date (UTC)', { exact: true })).toHaveValue('2026-11-04');
  await expect(page.getByLabel('Due date (UTC)', { exact: true })).toHaveValue('2026-11-06');
  await expect(page.getByText('1 dependency scheduling conflict', { exact: true })).toBeVisible();
  await page.locator('.roadmap-task-label').filter({ hasText: 'Plan the next release' }).click();
  await page.getByLabel('Start date (UTC)', { exact: true }).fill('2026-11-08');
  await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(page.locator('.roadmap-warning')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('roadmap-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('roadmap-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await waitForWorkspace(page, () => page.reload());
  await navigate('Roadmap');
  await expect(page.getByLabel('Start date (UTC)', { exact: true })).toHaveValue('2026-11-04');
  await expect(page.getByLabel('Due date (UTC)', { exact: true })).toHaveValue('2026-11-06');
  await page.locator('.roadmap-task-label').filter({ hasText: 'Plan the next release' }).click();
  await expect(page.getByLabel('Start date (UTC)', { exact: true })).toHaveValue('2026-11-08');
  await expect(page.getByLabel('Due date (UTC)', { exact: true })).toHaveValue('2026-11-08');
  await expect(page.getByLabel('Mark as a milestone')).toBeChecked();
  await navigate('Board');
  await expect(page.locator('.task-card h3').first()).toHaveCSS('font-size', '15px');
  await expect(page.locator('.task-number').first()).toHaveCSS('font-size', '12px');
  await expect(page.getByRole('button', { name: /Build the first release/ })).toBeVisible();
  await navigate('Analytics');
  await expect(
    page.getByRole('heading', { name: 'The week in motion', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.analytics-chart .recharts-surface')).toBeVisible();
  await navigate(/^Tasks/);
  await waitForWorkspace(page, () => page.reload());
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: /^Tasks/ })
    .click();
  await expect(
    page.locator('.task-table-row').filter({ hasText: 'Build the first release' }),
  ).toBeVisible();
  await expect(
    page.locator('.task-table-row').filter({ hasText: 'Plan the next release' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Build the first release/ }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption('IN_PROGRESS');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved' })).toBeVisible();
  await dialog.getByLabel('Write a comment').fill('Ready for the next milestone.');
  await dialog.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(dialog.getByText('Ready for the next milestone.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await navigate('Board');
  await expect(
    page
      .getByRole('region', { name: 'In progress', exact: true })
      .getByRole('button', { name: /Build the first release/ }),
  ).toBeVisible();
  await waitForWorkspace(page, () => page.reload());
  await page.keyboard.press('Control+k');
  dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox').fill('Build the first release');
  await expect(dialog.getByRole('option', { name: /Build the first release/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByLabel('Title', { exact: true })).toHaveValue(
    'Build the first release',
  );
  await expect(
    page.getByRole('dialog').getByRole('combobox', { name: 'Status', exact: true }),
  ).toHaveValue('IN_PROGRESS');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await openAppNavigation(page);
  await page.getByRole('button', { name: 'Settings & members', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(pageErrors).toEqual([]);
});
