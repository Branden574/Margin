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
async function addText(page: Page, text: string, y = 230) {
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.editor-annotation-layer').click({ position: { x: 100, y } });
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
  await expect(
    page.getByText(
      'Submission is not configured for this Canvas launch. Your saved edits remain available.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit assignment', exact: true })).toHaveCount(0);
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

test('submission capture freezes acknowledged work while later draft edits stay separate', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const fixture = await installFixture(page);
  fixture.state.submissionsConfigured = true;
  await openWork(page);
  await addText(page, 'Answer preserved in the first submission');
  await page.getByRole('button', { name: 'Submit assignment', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Canvas submission', exact: true });
  await expect(panel.getByText('Submission version saved', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('Preparing submission. Not submitted to Canvas yet.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Not submitted to Canvas', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  expect(fixture.captures).toHaveLength(1);
  expect(fixture.operations).toHaveLength(1);
  expect(fixture.submissions).toHaveLength(1);
  const first = structuredClone(fixture.submissions[0]);
  const frozen = structuredClone(fixture.frozenOperations.get(first.id));
  expect(first.frozenCursor).toBe(1);
  expect(frozen).toHaveLength(1);
  expect(JSON.stringify(frozen)).toContain('Answer preserved in the first submission');
  const a11y = await new AxeBuilder({ page })
    .include('.canvas-submission')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await panel.getByRole('button', { name: 'Continue draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await addText(page, 'Later draft is not in the preserved version', 330);
  await page.getByRole('button', { name: 'Sync saved edits', exact: true }).click();
  await expect(
    page.getByText('Server has acknowledged the saved edits.', { exact: true }),
  ).toBeVisible();
  expect(fixture.operations).toHaveLength(2);
  expect(fixture.submissions).toEqual([first]);
  expect(fixture.frozenOperations.get(first.id)).toEqual(frozen);
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(
    page.getByText('Later draft is not in the preserved version', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Submission version saved', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Submit assignment', exact: true })).toHaveCount(
    0,
  );
  await panel.getByRole('button', { name: 'Check submission status', exact: true }).click();
  await expect(
    panel.getByText('Preparing submission. Not submitted to Canvas yet.', { exact: true }),
  ).toBeVisible();
  expect(fixture.captures).toHaveLength(1);
  expect(failures).toEqual([]);
});

test('lost capture acknowledgement survives encrypted reload and retries the exact immutable request', async ({
  page,
}) => {
  const fixture = await installFixture(page);
  fixture.state.submissionsConfigured = true;
  await openWork(page);
  await addText(page, 'Retain this submission despite a lost response');
  fixture.state.loseNextCaptureAcknowledgement = true;
  fixture.state.hideSubmissionRequests = true;
  await page.getByRole('button', { name: 'Submit assignment', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Canvas submission', exact: true });
  await expect(
    panel.getByRole('button', { name: 'Confirm saved submission', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Continue draft', exact: true })).toHaveCount(0);
  expect(fixture.captures).toHaveLength(1);
  expect(fixture.submissions).toHaveLength(1);
  const original = structuredClone(fixture.captures[0]);
  await page.reload();
  await unlockWorkspace(page);
  await expect(
    panel.getByRole('button', { name: 'Confirm saved submission', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  expect(fixture.captures).toEqual([original]);
  fixture.state.hideSubmissionRequests = false;
  await panel.getByRole('button', { name: 'Confirm saved submission', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Continue draft', exact: true })).toBeEnabled();
  expect(fixture.captures).toEqual([original, original]);
  expect(fixture.submissions).toHaveLength(1);
  await expect(page.getByText('Not submitted to Canvas', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(
    page.getByText('Retain this submission despite a lost response', { exact: true }),
  ).toBeVisible();
});

test('durable capture rejection keeps editing paused until the exact fresh receipt releases the draft', async ({
  page,
}) => {
  const fixture = await installFixture(page);
  fixture.state.submissionsConfigured = true;
  await openWork(page);
  await addText(page, 'Preserve the draft after a fenced rejection');
  fixture.state.rejectNextCapture = 'cursor_changed';
  await page.getByRole('button', { name: 'Submit assignment', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Canvas submission', exact: true });
  await expect(panel.getByText('Submission was not created', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  expect(fixture.submissions).toHaveLength(0);
  const rejected = structuredClone(fixture.captures[0]);
  await page.reload();
  await unlockWorkspace(page);
  await expect(panel.getByRole('button', { name: 'Continue draft', exact: true })).toBeEnabled();
  fixture.state.hideSubmissionRequests = true;
  await panel.getByRole('button', { name: 'Continue draft', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Continue draft', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  expect(fixture.captures).toEqual([rejected]);
  fixture.state.hideSubmissionRequests = false;
  await panel.getByRole('button', { name: 'Continue draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(
    page.getByText('Preserve the draft after a fenced rejection', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Submit assignment', exact: true }).click();
  await expect(panel.getByText('Submission version saved', { exact: true })).toBeVisible();
  expect(fixture.captures).toHaveLength(2);
  expect(fixture.captures[1].requestId).not.toBe(rejected.requestId);
  expect(fixture.submissionRequests.get(rejected.requestId)).toMatchObject({
    state: 'rejected',
    code: 'cursor_changed',
  });
  expect(fixture.submissions).toHaveLength(1);
});
