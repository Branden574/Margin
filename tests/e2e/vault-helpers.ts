import { expect, type Page } from '@playwright/test';
export const TEST_PASSPHRASE = 'test-only-margin-workspace-2026';
export async function unlockWorkspace(page: Page, readySelector = '.app-shell,.document-editor') {
  await expect
    .poll(
      async () =>
        (await page.locator('[name="passphrase"]').isVisible()) ||
        (await page.locator(readySelector).isVisible()),
      { timeout: 15000 },
    )
    .toBeTruthy();
  if (!(await page.locator('[name="passphrase"]').isVisible())) return;
  await page.getByLabel('Workspace passphrase', { exact: true }).fill(TEST_PASSPHRASE);
  if (await page.getByLabel('Confirm passphrase', { exact: true }).isVisible()) {
    await page.getByLabel('Confirm passphrase', { exact: true }).fill(TEST_PASSPHRASE);
    await page.getByRole('button', { name: 'Create private workspace', exact: true }).click();
  } else await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  await expect(page.locator(readySelector)).toBeVisible({ timeout: 20000 });
}
