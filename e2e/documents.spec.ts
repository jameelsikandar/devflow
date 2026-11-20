import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
import type { ProjectDocumentView } from '../src/lib/documents';

async function documents(page: Page, projectId: string) {
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Documents', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Document project', exact: true })
    .selectOption(projectId);
  return page.getByRole('region', { name: 'Project documents', exact: true });
}
async function keyboardDialog(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  // Exercise the real Radix focus trap in both directions, without assuming DOM order.
  const controls = await dialog
    .locator('button, input, textarea, select, a[href], [tabindex="0"]')
    .count();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < controls + 2; i++) {
      await page.keyboard.press(key);
      await expect
        .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
    }
  }
}
async function register(page: Page, name: string, email: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-m41-browser-password');
  await submitRegistration(page);
  const response = await page.request.get('/api/me');
  expect(response.status()).toBe(200);
  return (await response.json()) as { user: { id: string }; workspaces: { id: string }[] };
}

test.skip(
  process.env.M41_BROWSER_ACCEPTANCE !== 'devflow_test-only',
  'Execute only through the reviewed isolated documents.config.ts procedure.',
);

test.beforeAll(({}, testInfo) => {
  expect(
    testInfo.config.configFile?.replaceAll('\\', '/').endsWith('/e2e/documents.config.ts'),
  ).toBe(true);
});

test('document lifecycle, member permissions and foreign workspace isolation', async ({
  page,
  context,
  browser,
}, testInfo) => {
  const suffix = randomUUID();
  const errors: string[] = [];
  const outbound: string[] = [];
  const origin = new URL(testInfo.project.use.baseURL as string).origin;
  const protect = async (target: typeof context) => {
    await target.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        outbound.push('Blocked nonlocal browser request');
        await route.abort();
      } else await route.continue();
    });
    target.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  };
  await protect(context);
  page.on('pageerror', (e) => errors.push(e.message));
  const owner = await register(page, 'Mira Documents', `m41-owner-${suffix}@example.com`);
  const workspaceId = owner.workspaces[0].id;
  await openAppNavigation(page);
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Projects', exact: true })
    .click();
  await page.getByRole('button', { name: 'New project', exact: true }).first().click();
  const projectDialog = page.getByRole('dialog');
  const projectName = `M41 acceptance ${suffix}`;
  await projectDialog.getByLabel('Project name').fill(projectName);
  await projectDialog.getByLabel('Description').fill('Synthetic browser acceptance only');
  const [projectResponse] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST',
    ),
    projectDialog.getByRole('button', { name: 'Create project', exact: true }).click(),
  ]);
  expect(projectResponse.status()).toBe(201);
  const project = (await projectResponse.json()) as { id: string };
  await expect(projectDialog).toHaveCount(0);
  let region = await documents(page, project.id);
  await expect(region.getByText('No documents you can access', { exact: true })).toBeVisible();
  const newButton = region.getByRole('button', { name: 'New document', exact: true });
  await newButton.focus();
  await page.keyboard.press('Enter');
  const create = page.getByRole('dialog', { name: 'New document', exact: true });
  await expect(create.getByLabel('Title', { exact: true })).toBeFocused();
  await keyboardDialog(page, create);
  await create.getByLabel('Title', { exact: true }).fill('Launch guide');
  await create.getByLabel('Summary', { exact: true }).fill('Browser acceptance summary');
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/projects/${project.id}/documents` &&
        r.request().method() === 'POST',
    ),
    create.getByRole('button', { name: 'Save document', exact: true }).click(),
  ]);
  expect(created.status()).toBe(201);
  const createdDocument = (await created.json()) as ProjectDocumentView;
  const endpoint = `/api/projects/${project.id}/documents/${createdDocument.id}?workspaceId=${workspaceId}`;
  let detail = page.getByRole('dialog', { name: 'Launch guide', exact: true });
  await expect(detail.getByText('Browser acceptance summary', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await waitForWorkspace(page, () => page.reload());
  region = await documents(page, project.id);
  const card = region.getByRole('button', { name: /Launch guide Browser acceptance summary/ });
  await card.focus();
  await page.keyboard.press('Enter');
  detail = page.getByRole('dialog', { name: 'Launch guide', exact: true });
  await detail.getByRole('button', { name: 'Rename or edit summary', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename document', exact: true });
  await keyboardDialog(page, rename);
  await rename.getByLabel('Title', { exact: true }).fill('Release guide');
  await rename.getByRole('button', { name: 'Save document', exact: true }).click();
  detail = page.getByRole('dialog', { name: 'Release guide', exact: true });
  await expect(detail).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Rename document', exact: true })).toHaveCount(0);

  // A real non-admin membership is established through existing invite APIs.
  // No Prisma imports, privileged database fixtures or mocked authorization.
  const memberContext = await browser.newContext({ ...testInfo.project.use, baseURL: origin });
  const foreignContext = await browser.newContext({ ...testInfo.project.use, baseURL: origin });
  try {
    await protect(memberContext);
    await protect(foreignContext);
    const memberPage = await memberContext.newPage();
    const memberEmail = `m41-reader-${suffix}@example.com`;
    const member = await register(memberPage, 'Robin Reader', memberEmail);
    const headers = { Origin: origin };
    const invitation = await page.request.post(`/api/invites?workspaceId=${workspaceId}`, {
      headers,
      data: { email: memberEmail },
    });
    expect(invitation.status()).toBe(201);
    const token = new URL(((await invitation.json()) as { url: string }).url).searchParams.get(
      'invite',
    );
    expect(token).toBeTruthy();
    const accepted = await memberPage.request.post('/api/invites/accept', {
      headers,
      data: { token },
    });
    expect(accepted.status()).toBe(200);
    // Select the accepted workspace using the existing persisted preference contract.
    // This changes browser-local state only, not server-side permissions.
    await memberPage.evaluate((id) => {
      const raw = localStorage.getItem('devflow-preferences');
      const prefs = raw ? JSON.parse(raw) : { state: {}, version: 0 };
      prefs.state.workspaceId = id;
      localStorage.setItem('devflow-preferences', JSON.stringify(prefs));
    }, workspaceId);
    await waitForWorkspace(memberPage, () => memberPage.reload());
    const memberRegion = await documents(memberPage, project.id);
    await expect(
      memberRegion.getByText('No documents you can access', { exact: true }),
    ).toBeVisible();
    expect((await memberPage.request.get(endpoint)).status()).toBe(404);
    // Refresh the owner's membership snapshot before opening the access picker.
    await waitForWorkspace(page, () => page.reload());
    region = await documents(page, project.id);
    await region.getByRole('button', { name: /Release guide Browser acceptance summary/ }).click();
    detail = page.getByRole('dialog', { name: 'Release guide', exact: true });
    await detail.getByLabel('Workspace member', { exact: true }).selectOption(member.user.id);
    await detail.getByLabel('Permission', { exact: true }).selectOption('READER');
    await detail.getByRole('button', { name: 'Save access', exact: true }).click();
    await expect(detail.getByText('Robin Reader · Reader', { exact: true })).toBeVisible();
    await memberPage.reload();
    await documents(memberPage, project.id);
    await memberPage
      .getByRole('button', { name: /Release guide Browser acceptance summary/ })
      .click();
    const readerDialog = memberPage.getByRole('dialog', { name: 'Release guide', exact: true });
    await expect(readerDialog).toBeVisible();
    await expect(
      readerDialog.getByRole('button', { name: 'Rename or edit summary', exact: true }),
    ).toHaveCount(0);
    await expect(
      readerDialog.getByRole('region', { name: 'Document permissions', exact: true }),
    ).toHaveCount(0);
    const current = (await (await page.request.get(endpoint)).json()) as ProjectDocumentView;
    expect(
      (
        await memberPage.request.patch(endpoint, {
          headers,
          data: { title: 'Forbidden rename', version: current.version },
        })
      ).status(),
    ).toBe(403);
    await detail.getByLabel('Permission', { exact: true }).selectOption('EDITOR');
    await detail.getByRole('button', { name: 'Save access', exact: true }).click();
    await expect(detail.getByText('Robin Reader · Editor', { exact: true })).toBeVisible();
    await memberPage.reload();
    await documents(memberPage, project.id);
    await memberPage
      .getByRole('button', { name: /Release guide Browser acceptance summary/ })
      .click();
    await expect(
      memberPage
        .getByRole('dialog')
        .getByRole('button', { name: 'Rename or edit summary', exact: true }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole('dialog').getByRole('button', { name: 'Archive document', exact: true }),
    ).toHaveCount(0);
    const editorBefore = (await (
      await memberPage.request.get(endpoint)
    ).json()) as ProjectDocumentView;
    await memberPage
      .getByRole('dialog')
      .getByRole('button', { name: 'Rename or edit summary', exact: true })
      .click();
    const editorForm = memberPage.getByRole('dialog', { name: 'Rename document', exact: true });
    await editorForm.getByLabel('Summary', { exact: true }).fill('Browser acceptance summary');
    await editorForm.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(editorForm).toHaveCount(0);
    const editorAfter = (await (
      await memberPage.request.get(endpoint)
    ).json()) as ProjectDocumentView;
    expect(editorAfter.version).toBe(editorBefore.version + 1);
    // Reload owner detail after the editor's real successful metadata write.
    await waitForWorkspace(page, () => page.reload());
    region = await documents(page, project.id);
    await region.getByRole('button', { name: /Release guide Browser acceptance summary/ }).click();
    detail = page.getByRole('dialog', { name: 'Release guide', exact: true });
    await expect(detail.getByText('Robin Reader · Editor', { exact: true })).toBeVisible();
    await detail
      .getByRole('button', { name: 'Remove access for Robin Reader', exact: true })
      .click();
    await expect(detail.getByText('Robin Reader · Editor', { exact: true })).toHaveCount(0);
    expect((await memberPage.request.get(endpoint)).status()).toBe(404);

    const foreignPage = await foreignContext.newPage();
    const foreign = await register(
      foreignPage,
      'Finley Foreign',
      `m41-foreign-${suffix}@example.com`,
    );
    expect((await foreignPage.request.get(endpoint)).status()).toBe(404);
    const mismatched = endpoint.replace(workspaceId, foreign.workspaces[0].id);
    expect((await foreignPage.request.get(mismatched)).status()).toBe(404);
    const foreignList = await foreignPage.request.get(
      `/api/projects/${project.id}/documents?workspaceId=${foreign.workspaces[0].id}`,
    );
    expect(foreignList.status()).toBe(404);

    await detail.getByRole('button', { name: 'Archive document', exact: true }).click();
    let confirm = page.getByRole('dialog', { name: 'Archive this document?', exact: true });
    await keyboardDialog(page, confirm);
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(
      ((await (await page.request.get(endpoint)).json()) as ProjectDocumentView).archivedAt,
    ).toBeNull();
    await detail.getByRole('button', { name: 'Archive document', exact: true }).click();
    confirm = page.getByRole('dialog', { name: 'Archive this document?', exact: true });
    await confirm.getByRole('button', { name: 'Confirm archive', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(detail.getByText(/Read-only/)).toBeVisible();
    await expect(
      detail.getByRole('button', { name: 'Rename or edit summary', exact: true }),
    ).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Save access', exact: true })).toHaveCount(0);
    const archived = (await (await page.request.get(endpoint)).json()) as ProjectDocumentView;
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (
        await page.request.patch(endpoint, {
          headers,
          data: { title: 'Cannot edit archive', version: archived.version },
        })
      ).status(),
    ).toBe(409);
    await detail.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await region.getByLabel('Document state', { exact: true }).selectOption('archived');
    await region.getByRole('button', { name: /Release guide Browser acceptance summary/ }).click();
    await expect(detail.getByText(/Read-only/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('documents-dark.png'), fullPage: true });
    await detail.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await waitForWorkspace(page, () => page.reload());
    region = await documents(page, project.id);
    await expect(
      region.getByRole('button', { name: /Release guide Browser acceptance summary/ }),
    ).toHaveCount(0);
    await region.getByLabel('Document state', { exact: true }).selectOption('archived');
    await expect(
      region.getByRole('button', { name: /Release guide Browser acceptance summary/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('documents-light.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(outbound).toEqual([]);
  } finally {
    await memberContext.close();
    await foreignContext.close();
  }
});
