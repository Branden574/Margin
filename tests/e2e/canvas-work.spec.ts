import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { canvasWorkFixture } from '../fixtures/canvas-work-service';
import { TEST_PASSPHRASE, unlockWorkspace } from './vault-helpers';

async function installFixture(page: Page) {
  const fixture = await canvasWorkFixture();
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
async function openWork(page: Page) {
  await page.goto('/');
  await unlockWorkspace(page);
  await page.goto('/canvas/work');
  await unlockWorkspace(page);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
}
async function addText(page: Page, text: string) {
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 100, y: 230 } });
  await page.getByLabel('Annotation text', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
}

test('verified assignment source, local edits, acknowledged sync and reload use the student editor', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const fixture = await installFixture(page);
  await openWork(page);
  await expect(page.getByText('Not submitted to Canvas', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Draw', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add signature', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Fill form', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Crop page', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Rotate clockwise', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Page options', exact: true }).click();
  await addText(page, 'Synthetic student answer');
  await page.getByRole('button', { name: 'Sync saved edits', exact: true }).click();
  await expect(
    page.getByText('Server has acknowledged the saved edits.', { exact: true }),
  ).toBeVisible();
  expect(fixture.operations).toHaveLength(1);
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByText('Synthetic student answer', { exact: true })).toBeVisible();
  expect(fixture.state.sourceReads).toBe(1);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(failures).toEqual([]);
});

test('lost acknowledgement reconciles the same edit and session revocation clears the editor', async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await openWork(page);
  await addText(page, 'Retain this interrupted answer');
  fixture.state.loseNextAcknowledgement = true;
  await page.getByRole('button', { name: 'Sync saved edits', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved edit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry saved edit', exact: true }).click();
  await expect(
    page.getByText('Server has acknowledged the saved edits.', { exact: true }),
  ).toBeVisible();
  expect(fixture.operations).toHaveLength(1);
  expect(fixture.received).toHaveLength(1);
  await expect(page.getByText('Retain this interrupted answer', { exact: true })).toBeVisible();
  fixture.state.authorized = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Reopen this assignment from Canvas', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.document-editor')).toHaveCount(0);
  await expect(page.getByText('Retain this interrupted answer', { exact: true })).toHaveCount(0);
  fixture.state.authorized = true;
  await page.reload();
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(TEST_PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.getByText('Retain this interrupted answer', { exact: true })).toBeVisible();
});
