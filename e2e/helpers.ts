import { expect, type Page } from '@playwright/test';

/** Wait for real workspace data, including on the first cold Next.js compilation. */
export async function waitForWorkspace(page: Page, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/snapshot' && r.request().method() === 'GET',
    ),
    action(),
  ]);
  expect(response.status(), 'Workspace snapshot must load successfully').toBe(200);
}

export async function submitRegistration(page: Page) {
  await waitForWorkspace(page, async () => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/auth/register' && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Create account', exact: true }).click(),
    ]);
    expect(response.status(), 'Registration must succeed before navigating').toBe(201);
  });
}

export async function openAppNavigation(page: Page) {
  // Attached waits for hydration; isVisible alone can return false before mounting.
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .waitFor({ state: 'attached' });
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  const closer = page.getByRole('button', { name: 'Close navigation', exact: true });
  if ((await opener.isVisible()) && !(await closer.isVisible())) await opener.click();
}
