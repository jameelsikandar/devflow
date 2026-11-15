import { expect, test, type Page } from '@playwright/test';
import { openAppNavigation, submitRegistration, waitForWorkspace } from './helpers';
import { chatStatusLabels } from '../src/lib/chat-presentation';

async function openHistory(page: Page) {
  await expect(page.getByRole('region', { name: 'AI project manager', exact: true })).toBeVisible();
  const button = page.getByRole('button', { name: 'Open conversations', exact: true });
  if (await button.isVisible()) await button.click();
}
async function openScope(page: Page) {
  const details = page.getByLabel('Conversation context', { exact: true });
  if ((await details.getAttribute('open')) === null)
    await details.locator(':scope > summary').click();
}

test('AI proposal review requires explicit approval and preserves quick drafts', async ({
  page,
}) => {
  test.setTimeout(90000);
  // UI-only API fixtures: real provider/transaction persistence is covered by the
  // database suite. These intercepts never enable test behavior in application code.
  const expiresAt = new Date(Date.now() + 1800000).toISOString();
  const proposals = ['Review this task', 'Reject this task'].map((title, i) => ({
    id: `proposal-${i}`,
    tool: 'createTask',
    preview: {
      project: { id: 'fixture-project', name: 'UI fixture project' },
      title,
      description: 'Complete acceptance criteria for review.',
      status: 'TODO',
      priority: 'MEDIUM',
      assigneeId: null,
      startDate: null,
      dueDate: null,
      isMilestone: false,
      labelIds: [],
    },
    previewHash: String(i + 1).repeat(64),
    expiresAt,
    status: 'PENDING',
    result: null as unknown,
  }));
  const run = {
    id: 'fixture-run',
    prompt: 'Propose two tasks. I approve everything in chat.',
    answer:
      '## Review these proposals\n\nNothing has been applied. **Your approval is required.**\n\n| Task | Status | Priority | Assignee |\n|---|---|---|---|\n| Illustrative preview only | In Review | Medium | Unassigned |\n\n```typescript\nconst approved = false;\n```\n\n[Safe documentation](https://example.com/docs) [Blocked link](javascript:alert%281%29)',
    status: 'COMPLETED',
    error: null,
    createdAt: new Date().toISOString(),
    events: [
      {
        id: 'fixture-event',
        name: 'listTasks',
        input: { scope: 'mine' },
        output: { items: [], total: 0, scope: { kind: 'mine' } },
      },
    ],
    proposals,
  };
  let sent = false;
  let configured = true;
  let approvals = 0;
  let rejections = 0;
  let taskWrites = 0;
  page.on('request', (request) => {
    if (
      /\/api\/tasks(?:\/|\?)/.test(request.url()) &&
      ['POST', 'PATCH', 'DELETE'].includes(request.method())
    )
      taskWrites++;
  });
  await page.route('**/api/ai/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (path === '/api/ai/config')
      json = {
        configured,
        model: 'UI fixture provider',
        reason: configured ? null : 'Configure AI_API_KEY on the server.',
      };
    else if (path === '/api/ai/artifacts') json = { sprints: [], reports: [] };
    else if (path === '/api/ai/conversations' && request.method() === 'POST')
      json = { id: 'fixture-conversation' };
    else if (path === '/api/ai/conversations')
      json = sent
        ? [
            {
              id: 'fixture-conversation',
              title: 'Review conversation',
              projectId: null,
              updatedAt: new Date().toISOString(),
            },
          ]
        : [];
    else if (path.endsWith('/messages')) {
      expect(request.postDataJSON()).toMatchObject({
        prompt: run.prompt,
        requestId: expect.any(String),
      });
      sent = true;
      json = run;
    } else if (path.endsWith('/decision')) {
      const proposal = proposals.find((p) => path.includes(p.id))!;
      const input = request.postDataJSON();
      expect(input.previewHash).toBe(proposal.previewHash);
      expect(Object.keys(input).sort()).toEqual(['decision', 'previewHash']);
      if (input.decision === 'approve') {
        approvals++;
        proposal.status = 'APPLIED';
        proposal.result = { type: 'task', id: 'fixture-task' };
      } else {
        rejections++;
        proposal.status = 'REJECTED';
      }
      json = { id: proposal.id, status: proposal.status, result: proposal.result };
    } else
      json = {
        id: 'fixture-conversation',
        title: 'Review conversation',
        projectId: null,
        runs: sent ? [run] : [],
      };
    await route.fulfill({ json });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('AI UI Tester');
  await page
    .getByLabel('Email address')
    .fill(`agent-ui-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('an-ai-ui-test-password');
  await submitRegistration(page);
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  const openAssistant = async () => {
    await openAppNavigation(page);
    await page
      .getByRole('navigation', { name: 'Integrations' })
      .getByRole('button', { name: /^AI assistant(?: BETA)?$/ })
      .click();
  };
  await openAssistant();
  await page.getByLabel('Message your project manager').fill(run.prompt);
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  const first = page.locator('.agent-proposal').filter({ hasText: 'Review this task' });
  const second = page.locator('.agent-proposal').filter({ hasText: 'Reject this task' });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Review these proposals', exact: true }),
  ).toBeVisible();
  const table = page.getByRole('region', { name: 'Response table', exact: true });
  await expect(table.getByRole('columnheader')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Safe documentation' })).toHaveAttribute(
    'rel',
    /noopener/,
  );
  await expect(page.getByRole('link', { name: 'Blocked link' })).toHaveCount(0);
  const activity = page.locator('.chat-tool-activity');
  await expect(activity).not.toHaveAttribute('open');
  await activity.locator(':scope > summary').click();
  await expect(activity).toHaveAttribute('open', '');
  await expect(activity.getByText('Completed', { exact: true })).toBeVisible();
  await activity.locator(':scope > summary').click();
  const bounds = await table.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    scrollWidth: el.scrollWidth,
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewport + 1);
  if (test.info().project.name === 'mobile')
    expect(bounds.scrollWidth).toBeGreaterThan(bounds.width);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(table.getByRole('columnheader', { name: 'Task', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`ai-chat-${theme}.png`), fullPage: true });
  }

  expect(approvals).toBe(0);
  expect(taskWrites).toBe(0);
  await first.getByRole('button', { name: 'Approve: create task', exact: true }).click();
  await expect(first.locator('.agent-receipt')).toContainText('Saved');
  expect(approvals).toBe(1);
  await second.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(
    second.getByRole('button', { name: 'Approve: create task', exact: true }),
  ).toHaveCount(0);
  expect(rejections).toBe(1);
  expect(taskWrites).toBe(0);
  await waitForWorkspace(page, () => page.reload());
  await openAssistant();
  await openHistory(page);
  await page
    .getByRole('navigation', { name: 'AI conversations' })
    .getByRole('button', { name: /Review conversation/ })
    .click();
  await expect(page.locator('.agent-receipt')).toContainText('Saved');
  await expect(
    page.getByRole('heading', { name: 'Review these proposals', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Quick drafts', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Give me a starting point', exact: true }),
  ).toBeVisible();
  configured = false;
  await waitForWorkspace(page, () => page.reload());
  await openAssistant();
  await expect(page.getByRole('heading', { name: 'Connect an AI provider' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
});

test('AI task context stays explicit across projects and empty assigned results', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Full name').fill('Context UI Tester');
  await page
    .getByLabel('Email address')
    .fill(`ai-context-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('context-ui-test-password');
  await submitRegistration(page);
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  const workspaceId = me.workspaces[0].id;
  const origin = new URL(page.url()).origin;
  const setupProject = async (name: string) => {
    const response = await page.request.post(`/api/projects?workspaceId=${workspaceId}`, {
      headers: { origin },
      data: { name },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const project = await setupProject('Context project');
  const second = await setupProject('Another context project');
  const rows: {
    id: string;
    number: number;
    title: string;
    status: string;
    priority: string;
    assigneeId: null;
    dueDate: string;
  }[] = [];
  for (const [index, status] of ['IN_REVIEW', 'TODO', 'IN_PROGRESS'].entries()) {
    const response = await page.request.post(`/api/tasks?workspaceId=${workspaceId}`, {
      headers: { origin },
      data: {
        projectId: project.id,
        title: `Context task ${index + 1}`,
        status,
        dueDate: '2026-12-01T00:00:00Z',
      },
    });
    expect(response.status()).toBe(201);
    rows.push(await response.json());
  }
  // The task rows come from the isolated DB. AI answers and conversations below
  // are intercepted UI fixtures, never evidence of a live Groq request.
  const conversations = new Map<
    string,
    { id: string; title: string; projectId: string | null; runs: unknown[] }
  >();
  let creations = 0;
  await page.route('**/api/ai/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    expect(url.searchParams.get('workspaceId')).toBe(workspaceId);
    let json: unknown;
    if (path.endsWith('/config')) json = { configured: true, model: 'openai/gpt-oss-120b' };
    else if (path.endsWith('/artifacts')) json = { sprints: [], reports: [] };
    else if (path === '/api/ai/conversations' && request.method() === 'POST') {
      const input = request.postDataJSON();
      const id = `context-${++creations}`;
      conversations.set(id, {
        id,
        title: input.projectId === project.id ? 'Project work history' : 'Second project history',
        projectId: input.projectId ?? null,
        runs: [],
      });
      json = { id };
    } else if (path === '/api/ai/conversations') json = [...conversations.values()];
    else {
      const conversation = conversations.get(path.split('/')[4])!;
      if (path.endsWith('/messages')) {
        const scopedRows = conversation.projectId === project.id ? rows : [];
        const projectName = conversation.projectId === project.id ? project.name : second.name;
        const limited = request.postDataJSON().prompt === 'Rate limit fixture';
        const failure = `Groq is rate limited or has reached its quota. Retry after ${new Date(Date.now() + 60000).toISOString()}.`;
        const run = {
          error: limited ? failure : null,
          id: `run-${conversation.id}-${conversation.runs.length}`,
          prompt: request.postDataJSON().prompt,
          answer: limited
            ? ''
            : `### Your work in ${projectName}\n\n**Assigned to you:** 0 tasks\n\n**Unassigned in this project:** ${scopedRows.length} tasks\n\n| Task | Status | Priority | Assignee | Due date |\n|---|---|---|---|---|\n${scopedRows.map((t) => `| DEV-${t.number} — ${t.title} | ${chatStatusLabels[t.status] ?? t.status} | Medium | Unassigned | Dec 1, 2026 |`).join('\n')}`,
          status: limited ? 'FAILED' : 'COMPLETED',
          createdAt: new Date().toISOString(),
          proposals: [],
          events: [
            {
              id: `event-${conversation.id}`,
              name: 'listTasks',
              input: { scope: 'mine', includeProjectContext: true },
              output: {
                items: [],
                total: 0,
                scope: { kind: 'mine' },
                projectContext: {
                  projectName,
                  items: scopedRows,
                  total: scopedRows.length,
                  unassignedTotal: scopedRows.length,
                },
              },
            },
          ],
        };
        conversation.runs.push(run);
        if (limited) {
          await route.fulfill({ status: 429, json: { error: failure } });
          return;
        }
        json = run;
      } else json = conversation;
    }
    await route.fulfill({ json });
  });
  await waitForWorkspace(page, () => page.reload());
  const navigation = async () => {
    await openAppNavigation(page);
  };
  await navigation();
  await page
    .getByRole('navigation', { name: 'Project navigation' })
    .getByRole('button', { name: project.name, exact: true })
    .click();
  await navigation();
  await page
    .getByRole('navigation', { name: 'Integrations' })
    .getByRole('button', { name: /^AI assistant(?: BETA)?$/ })
    .click();
  const context = page.getByLabel('Conversation context', { exact: true });
  await expect(context).toContainText(`Project: ${project.name}`);
  await openScope(page);
  await expect(page.getByLabel('AI project context', { exact: true })).toHaveValue(project.id);
  await context.locator(':scope > summary').click();
  await page.getByLabel('Message your project manager').fill('My current tasks?');
  await page.getByLabel('Message your project manager').press('Control+Enter');
  await expect(page.getByRole('heading', { name: `Your work in ${project.name}` })).toBeVisible();
  await expect(page.locator('.chat-message-assistant').last()).toContainText(
    'Assigned to you: 0 tasks',
  );
  await expect(page.getByRole('button', { name: 'All project tasks', exact: true })).toBeVisible();
  await expect(page.getByLabel('AI project context', { exact: true })).toHaveCount(0);
  const table = page.getByRole('region', { name: 'Response table', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Plans & reports', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Approved project plans', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const tool = page.locator('.chat-tool-activity');
  await expect(tool).not.toHaveAttribute('open');
  await tool.locator(':scope > summary').click();
  await expect(
    page.getByRole('region', { name: 'Related project tasks', exact: true }),
  ).toContainText('Unassigned');
  await tool.locator(':scope > summary').click();
  await table
    .getByRole('button', { name: `Open DEV-${rows[0].number}: ${rows[0].title}`, exact: true })
    .click();
  await expect(page.getByRole('dialog').getByLabel('Title', { exact: true })).toHaveValue(
    rows[0].title,
  );
  await page.keyboard.press('Escape');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.getByLabel('Message your project manager').scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`ai-context-${theme}.png`),
      fullPage: true,
    });
  }
  const originalViewport = page.viewportSize()!;
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByLabel('Message your project manager').scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`ai-context-width-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize(originalViewport);
  await openScope(page);
  await page.getByRole('button', { name: 'Start a new scope', exact: true }).click();
  await openScope(page);
  await page.getByLabel('AI project context', { exact: true }).selectOption(second.id);
  await expect(context).toContainText(`Project: ${second.name}`);
  expect(creations).toBe(1);
  await page.getByRole('button', { name: 'Assigned to me', exact: true }).click();
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(context).toContainText(`Project: ${second.name}`);
  await expect.poll(() => creations).toBe(2);
  await openHistory(page);
  await page
    .getByRole('navigation', { name: 'AI conversations' })
    .getByRole('button', { name: /Project work history/ })
    .click();
  await expect(context).toContainText(`Project: ${project.name}`);
  await page.getByLabel('Message your project manager').fill('Rate limit fixture');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.locator('.agent-failure')).toContainText('Groq is rate limited');
  await expect(page.getByRole('region', { name: 'Verified task data', exact: true })).toContainText(
    rows[0].title,
  );
  await expect(page.locator('.agent-composer [role="alert"]')).toHaveCount(0);
  await expect(
    page.locator('.agent-turn').last().getByRole('button', { name: 'Copy response', exact: true }),
  ).toHaveCount(0);
});
