import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { canvasReviewFixture } from '../fixtures/canvas-review-service';
import { unlockWorkspace } from './vault-helpers';

async function install(page: Page) {
  const fixture = await canvasReviewFixture();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    await route.fulfill(await fixture.handle(new URL(request.url()), request.method()));
  });
  return fixture;
}
async function open(page: Page) {
  await page.goto('/canvas/review');
  await unlockWorkspace(page);
  await expect(page.getByRole('heading', { name: 'Synthetic literature review' })).toBeVisible();
  await expect(page.locator('svg.review-annotation-layer text')).toContainText([
    'The familiar voice makes the scene feel hopeful.',
    '!',
  ]);
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('teacher review shows frozen layers, comments and both pages without editing controls', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await install(page);
  await open(page);
  await expect(
    page.getByText('Why does the writer describe the morning light here?', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.review-annotation-layer [data-annotation-id]')).toHaveCount(3);
  const layerOrder = await page
    .locator('.review-annotation-layer [data-annotation-type]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-annotation-type')));
  expect(layerOrder).toEqual(['highlight', 'text', 'comment']);
  await expect(page.getByText('later unsaved draft', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit assignment', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Student annotations', exact: true }).uncheck();
  await expect(page.locator('.review-annotation-layer')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Student annotations', exact: true }).check();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('svg.review-annotation-layer text')).toHaveText([
    "A second reading connects the gate to Mira's decision.",
  ]);
  await expect(page.getByText('No student comments on this page.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: /Fit page width, current zoom/ }).click();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(fixture.requests.every((request) => request.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
});

test('review navigation, history pagination, preparation states and lock reopen', async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  await page.getByRole('button', { name: 'Next submission', exact: true }).click();
  await expect(page.locator('svg.review-annotation-layer text')).toContainText([
    'The open gate suggests a new beginning.',
  ]);
  await page.getByRole('button', { name: 'Next submission', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preparing the captured version' })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next submission', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'This submission needs preparation' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'More submissions', exact: true }).click();
  await expect(page.locator('.review-submissions > li')).toHaveCount(2);
  await expect(page.locator('.review-annotation-layer')).toBeVisible();
  await page.getByRole('button', { name: 'Previous submissions', exact: true }).click();
  await expect(page.locator('.review-submissions > li')).toHaveCount(20);
  await expect(page.locator('.review-annotation-layer')).toBeVisible();
  await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock workspace', exact: true })).toBeVisible();
  await expect(page.locator('.review-annotation-layer')).toHaveCount(0);
  await unlockWorkspace(page);
  await expect(page.locator('.review-annotation-layer')).toBeVisible();
  expect(fixture.requests.every((request) => request.method === 'GET')).toBe(true);
});

test('damaged snapshots and revoked teacher access clear review instead of retaining another student', async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  fixture.state.corruptNextChunk = true;
  await page.getByRole('button', { name: 'Next submission', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('svg.review-annotation-layer text')).toContainText([
    'The open gate suggests a new beginning.',
  ]);
  fixture.state.authorized = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Reopen this assignment from Canvas' }),
  ).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.locator('.review-submissions')).toHaveCount(0);
});

test('teacher review at narrow width has reachable controls and no page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page);
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('svg.review-annotation-layer text')).toHaveText([
    "A second reading connects the gate to Mira's decision.",
  ]);
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('selected submission revocation is rechecked while teacher assignment access remains active', async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  fixture.state.denySnapshot = true;
  await expect(page.locator('canvas')).toHaveCount(0, { timeout: 35000 });
  await expect(page.getByRole('alert')).toContainText('no longer available');
  expect(fixture.state.authorized).toBe(true);
});

test('changing selection during an authority check keeps the new submission open', async ({
  page,
}) => {
  await install(page);
  await open(page);
  let reached!: () => void, release!: () => void;
  const requestReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/assignments/review/submissions/40000000-0000-4000-8000-000000000100',
    async (route) => {
      reached();
      await gate;
      await route
        .fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'review_unavailable',
              message: 'The older synthetic review is unavailable.',
            },
          }),
        })
        .catch(() => {});
    },
  );
  try {
    await requestReached;
    await page.getByRole('button', { name: 'Next submission', exact: true }).click();
    await expect(page.locator('svg.review-annotation-layer text')).toContainText([
      'The open gate suggests a new beginning.',
    ]);
  } finally {
    release();
  }
  await expect(
    page.getByRole('heading', { name: 'Submission 00000101', exact: true }),
  ).toBeVisible();
  await expect(page.locator('svg.review-annotation-layer text')).toContainText([
    'The open gate suggests a new beginning.',
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
