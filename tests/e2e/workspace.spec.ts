import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { unlockWorkspace } from './vault-helpers';
async function ready(page: Page, fragment = 'home') {
  await page.goto(`/#${fragment}`);
  await unlockWorkspace(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}
async function navigate(page: Page, name: string) {
  await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
}
async function menu(page: Page, name: string, action: string) {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function pdfBytes() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document
    .addPage([612, 792])
    .drawText('Local import verification', { x: 50, y: 730, font, size: 18 });
  return Buffer.from(await document.save());
}

test('creates a blank document, renames it, restores it from Trash and retains it on reload', async ({
  page,
}) => {
  await ready(page);
  await navigate(page, 'My documents');
  await page.getByRole('button', { name: 'Blank document', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document name' }).fill('Field journal');
  await page.getByRole('button', { name: 'Create document', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await navigate(page, 'My documents');
  await menu(page, 'Field journal', 'Rename');
  await page.getByRole('textbox', { name: 'Document name' }).fill('Field journal — revised');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByRole('button', { name: 'Actions for Field journal — revised', exact: true }),
  ).toBeVisible();
  await menu(page, 'Field journal — revised', 'Move to trash');
  await expect(
    page.getByRole('button', { name: 'Actions for Field journal — revised', exact: true }),
  ).toHaveCount(0);
  await navigate(page, 'Trash');
  await menu(page, 'Field journal — revised', 'Restore document');
  await navigate(page, 'My documents');
  await expect(
    page.getByRole('button', { name: 'Actions for Field journal — revised', exact: true }),
  ).toBeVisible();
  await page.reload();
  await unlockWorkspace(page);
  await expect(
    page.getByRole('button', { name: 'Actions for Field journal — revised', exact: true }),
  ).toBeVisible();
});

test('imports a real PDF locally and rejects a renamed unsupported file without adding it', async ({
  page,
}) => {
  await ready(page, 'documents');
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await page.getByLabel('Choose documents to upload').setInputFiles({
    name: 'Lesson evidence.pdf',
    mimeType: 'application/pdf',
    buffer: await pdfBytes(),
  });
  await expect(
    page.getByRole('button', { name: 'Actions for Lesson evidence', exact: true }),
  ).toBeVisible();
  await page.reload();
  await unlockWorkspace(page);
  await expect(
    page.getByRole('button', { name: 'Actions for Lesson evidence', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await page.getByLabel('Choose documents to upload').setInputFiles({
    name: 'False PDF.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html>This is not a PDF.</html>'),
  });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not a supported PDF');
  await expect(
    page.getByRole('button', { name: 'Actions for False PDF', exact: true }),
  ).toHaveCount(0);
});

test('saves settings and completes the explicitly local teacher/student assignment workflow', async ({
  page,
}) => {
  await ready(page, 'settings');
  await page.getByRole('textbox', { name: 'Display name' }).fill('Jordan Ellis');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'High contrast', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'contrast');
  await page.getByRole('switch', { name: 'Reduce motion' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await page.reload();
  await unlockWorkspace(page);
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('Jordan Ellis');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'contrast');
  await expect(page.getByRole('switch', { name: 'Reduce motion' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await navigate(page, 'Assignments');
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  await page.getByRole('textbox', { name: 'Assignment title' }).fill('Observe and explain');
  await page.getByRole('combobox', { name: 'Document', exact: true }).selectOption({ index: 1 });
  await page.getByRole('textbox', { name: 'Class', exact: true }).fill('Science workshop');
  await page.getByLabel('Due date', { exact: true }).fill('2026-10-20');
  await page
    .getByRole('textbox', { name: 'Instructions' })
    .fill('Add three observations to the document.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  const assignment = page.getByRole('button', { name: /Observe and explain Science workshop/ });
  await expect(assignment).toContainText('draft');
  await assignment.click();
  await page.getByRole('button', { name: 'Mark ready for students' }).click();
  await expect(assignment).toContainText('assigned');
  await navigate(page, 'Settings');
  await page.getByRole('combobox', { name: 'Workspace view' }).selectOption('student');
  await expect(page.locator('.sidebar-profile')).toContainText('Student workspace');
  await navigate(page, 'Assignments');
  await expect(page.getByRole('button', { name: 'Create assignment', exact: true })).toHaveCount(0);
  await assignment.click();
  await page.getByRole('button', { name: 'Mark as submitted locally' }).click();
  await expect(assignment).toContainText('submitted');
  await navigate(page, 'Settings');
  await page.getByRole('combobox', { name: 'Workspace view' }).selectOption('teacher');
  await expect(page.locator('.sidebar-profile')).toContainText('Teacher workspace');
  await navigate(page, 'Assignments');
  await assignment.click();
  await page
    .getByRole('textbox', { name: 'Return feedback' })
    .fill('Good observations. Add evidence for your second point.');
  await page.getByRole('button', { name: 'Return with feedback' }).click();
  await expect(assignment).toContainText('returned');
  await page.reload();
  await unlockWorkspace(page);
  await assignment.click();
  await expect(page.getByRole('dialog')).toContainText(
    'Good observations. Add evidence for your second point.',
  );
});

test('mobile navigation and settings remain operable without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await unlockWorkspace(page);
  await expect(page.getByRole('heading', { name: /Ready for your next lesson/ })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await navigate(page, 'Settings');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Display name' }).fill('Mobile learner');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await navigate(page, 'Home');
  await expect(
    page.getByRole('heading', { name: 'Ready for your next lesson, Mobile?' }),
  ).toBeVisible();
  const viewportWidth = await page.evaluate(() => ({
    total: document.documentElement.scrollWidth,
    visible: innerWidth,
  }));
  expect(viewportWidth.total).toBeLessThanOrEqual(viewportWidth.visible + 1);
});

test('a malformed URL fragment recovers to a usable workspace', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/#%E0%A4%A');
  await unlockWorkspace(page);
  await expect(page.getByRole('heading', { name: /Ready for your next lesson/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create assignment', exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('pausing a delayed backup reports a pause instead of claiming the PDF was backed up', async ({
  page,
}) => {
  let chunkStarted!: () => void;
  const chunkRequest = new Promise<void>((resolve) => {
    chunkStarted = resolve;
  });
  await page.route('**/api/uploads', async (route) => {
    const request = route.request().postDataJSON() as { totalSize: number; chunkSize: number };
    await route.fulfill({
      json: {
        id: 'u-delayed-backup',
        chunkSize: request.chunkSize,
        totalChunks: Math.ceil(request.totalSize / request.chunkSize),
        uploadedChunks: [],
        status: 'uploading',
      },
    });
  });
  await page.route('**/api/uploads/u-delayed-backup/chunks/*', async (route) => {
    chunkStarted();
    // A delayed network response keeps the upload in progress until the user pauses it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.abort('failed').catch(() => {});
  });
  await ready(page, 'settings');
  await page.getByLabel('Server access token').fill('test-local-backup-token-long-enough-for-test');
  await navigate(page, 'My documents');
  await page
    .getByRole('button', { name: /^Actions for / })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Upload encrypted copy' }).click();
  await chunkRequest;
  await page.getByRole('button', { name: 'Pause upload', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume upload', exact: true })).toBeVisible();
  await expect(
    page.getByText('Upload paused · original safe in your vault', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Encrypted upload stored in quarantine pending a scan.', { exact: true }),
  ).toHaveCount(0);
});
