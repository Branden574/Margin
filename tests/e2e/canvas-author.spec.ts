import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { canvasAuthorFixture } from '../fixtures/canvas-author-service';
import { unlockWorkspace } from './vault-helpers';

async function install(page: Page, fixture = canvasAuthorFixture()) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    await route.fulfill(
      await fixture.handle(
        new URL(request.url()),
        request.method(),
        request.postData() ?? undefined,
      ),
    );
  });
  return fixture;
}
async function openAuthor(page: Page) {
  await page.goto('/');
  await unlockWorkspace(page);
  await page.goto('/canvas/author');
  await unlockWorkspace(page);
  await expect(page.getByRole('button', { name: /Synthetic worksheet 1\.pdf/ })).toBeEnabled();
}
async function enterDraft(page: Page) {
  await page.getByRole('button', { name: /Synthetic worksheet 1\.pdf/ }).click();
  await page.getByLabel('Assignment title', { exact: true }).fill('Synthetic teacher assignment');
  await page.getByLabel(/Instructions/).fill('Read the document and explain your answer.');
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('teacher source pagination, encrypted reload, explicit creation and native Canvas return', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await install(page);
  await openAuthor(page);
  await expect(page.locator('.canvas-author-source')).toHaveCount(5);
  await enterDraft(page);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.canvas-author-source')).toHaveCount(1);
  await expect(page.locator('.canvas-author-selected')).toContainText('Synthetic worksheet 1.pdf');
  await page.getByRole('checkbox', { name: 'Draw', exact: true }).uncheck();
  await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByLabel('Assignment title', { exact: true })).toHaveValue(
    'Synthetic teacher assignment',
  );
  await expect(page.getByRole('checkbox', { name: 'Draw', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ready for Canvas review', exact: true }),
  ).toBeVisible();
  expect(fixture.assignments.size).toBe(1);
  expect(fixture.returns).toHaveLength(0);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  // A saved local receipt cannot directly authorize returning after a reload.
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByRole('button', { name: 'Return to Canvas', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm saved assignment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to Canvas', exact: true })).toBeEnabled();
  expect(fixture.assignments.size).toBe(1);
  expect(fixture.received).toHaveLength(2);
  expect(fixture.received[1]).toEqual(fixture.received[0]);
  const returned = page.waitForRequest((request) => request.url().endsWith('/return'));
  await page.getByRole('button', { name: 'Return to Canvas', exact: true }).click();
  const request = await returned;
  expect(request.method()).toBe('POST');
  expect(request.headers()['content-type']).toContain('application/x-www-form-urlencoded');
  expect(request.isNavigationRequest()).toBe(true);
  expect([...new URLSearchParams(request.postData()!).keys()].sort()).toEqual([
    'assignmentId',
    'csrfToken',
  ]);
  await expect(
    page.getByRole('heading', { name: 'Synthetic Canvas selection received' }),
  ).toBeVisible();
  expect(fixture.returns).toHaveLength(1);
  expect(fixture.returns[0].assignmentId).toBe([...fixture.assignments.values()][0].assignment.id);
  expect(errors).toEqual([]);
});

test('lost create response survives lock and reload and cannot be replaced after another rejection', async ({
  page,
}) => {
  const fixture = await install(page);
  await openAuthor(page);
  await enterDraft(page);
  fixture.state.loseNextCreateResponse = true;
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Confirm saved assignment', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Assignment title', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel selection', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock workspace', exact: true })).toBeVisible();
  await unlockWorkspace(page);
  await expect(
    page.getByRole('button', { name: 'Confirm saved assignment', exact: true }),
  ).toBeEnabled();
  fixture.state.failNextCreate = 400;
  await page.getByRole('button', { name: 'Confirm saved assignment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('synthetic request was rejected');
  await expect(page.getByLabel('Assignment title', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Confirm saved assignment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to Canvas', exact: true })).toBeEnabled();
  expect(fixture.assignments.size).toBe(1);
  expect(fixture.received).toHaveLength(3);
  expect(fixture.received[1]).toEqual(fixture.received[0]);
  expect(fixture.received[2]).toEqual(fixture.received[0]);
});

test('cancel returns an empty assignment through native form without creating anything', async ({
  page,
}) => {
  const fixture = await install(page);
  await openAuthor(page);
  await enterDraft(page);
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click();
  await page.getByRole('button', { name: 'Return without selection', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic Canvas selection received' }),
  ).toBeVisible();
  expect(fixture.assignments.size).toBe(0);
  expect(fixture.returns).toEqual([{ assignmentId: '', csrfToken: 'a'.repeat(43) }]);
});

test('revoked teacher authority hides setup and preserves the saved request for a fresh verified open', async ({
  page,
}) => {
  const fixture = await install(page);
  await openAuthor(page);
  await enterDraft(page);
  fixture.state.authorized = false;
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Reopen assignment setup from Canvas', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Assignment title', { exact: true })).toHaveCount(0);
  expect(fixture.received).toHaveLength(0);
  fixture.state.authorized = true;
  await page.reload();
  await unlockWorkspace(page);
  await expect(
    page.getByRole('button', { name: 'Confirm saved assignment', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm saved assignment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to Canvas', exact: true })).toBeEnabled();
  expect(fixture.assignments.size).toBe(1);
});

test('stale author tab cannot overwrite a newer draft and explicit discard reloads saved state', async ({
  page,
  context,
}) => {
  const fixture = await install(page);
  await openAuthor(page);
  await enterDraft(page);
  const other = await context.newPage();
  try {
    await install(other, fixture);
    await other.goto('/canvas/author');
    await unlockWorkspace(other);
    await expect(other.getByLabel('Assignment title', { exact: true })).toHaveValue(
      'Synthetic teacher assignment',
    );
    await page.getByLabel('Assignment title', { exact: true }).fill('Newer teacher draft');
    await expect(page.getByText('Draft saved on this device', { exact: true })).toBeVisible();
    await other.getByLabel('Assignment title', { exact: true }).fill('Stale teacher draft');
    await expect(other.getByRole('alert')).toContainText('changed in another tab');
    await expect(
      other.getByRole('button', { name: 'Create assignment', exact: true }),
    ).toBeDisabled();
    await other
      .getByRole('button', { name: 'Discard unsaved changes and reload', exact: true })
      .click();
    await other
      .getByRole('dialog')
      .getByRole('button', { name: 'Discard unsaved changes and reload', exact: true })
      .click();
    await unlockWorkspace(other);
    await expect(other.getByLabel('Assignment title', { exact: true })).toHaveValue(
      'Newer teacher draft',
    );
    expect(fixture.received).toHaveLength(0);
  } finally {
    await other.unrouteAll({ behavior: 'ignoreErrors' });
    await other.close();
  }
});

test('narrow layout keeps source and assignment controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await install(page);
  await openAuthor(page);
  await enterDraft(page);
  await page
    .getByRole('button', { name: 'Create assignment', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: 'Create assignment', exact: true }),
  ).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
