import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { canvasWorkFixture } from '../fixtures/canvas-work-service';
import { unlockWorkspace } from './vault-helpers';

// Local role preferences are presentation, not school authorization. These workflows
// use real encrypted browser storage and explicitly synthetic assignment metadata.
async function ready(page: Page) {
  await page.goto('/#home');
  await unlockWorkspace(page);
  await expect(page.getByRole('region', { name: 'Teacher dashboard', exact: true })).toBeVisible();
}
async function navigate(page: Page, name: string) {
  await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
}
async function role(page: Page, value: 'teacher' | 'student') {
  await navigate(page, 'Settings');
  await page.getByRole('combobox', { name: 'Workspace view', exact: true }).selectOption(value);
  await expect(page.locator('.sidebar-profile')).toContainText(
    value === 'teacher' ? 'Teacher workspace' : 'Student workspace',
  );
  await navigate(page, 'Home');
}
async function count(dashboard: Locator, label: string, amount: number) {
  await expect(
    dashboard.locator('.role-home-overview > div').filter({ hasText: label }).locator('strong'),
  ).toHaveText(String(amount));
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .include('.role-home')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}

test('teacher Home creates a real encrypted draft and consumes the quick action exactly once', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an assignment', exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('textbox', { name: 'Assignment title', exact: true })
    .fill('Dashboard-created draft');
  await dialog.getByRole('combobox', { name: 'Document', exact: true }).selectOption({ index: 1 });
  await dialog.getByRole('textbox', { name: 'Class', exact: true }).fill('Local science');
  await dialog.getByLabel('Due date', { exact: true }).fill('2026-10-20');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Dashboard-created draft Local science/ }),
  ).toContainText('draft');
  await navigate(page, 'Home');
  const dashboard = page.getByRole('region', { name: 'Teacher dashboard', exact: true });
  await count(dashboard, 'Drafts', 1);
  await dashboard.getByRole('button', { name: /Dashboard-created draft.*Finish draft/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Dashboard-created draft', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await navigate(page, 'My documents');
  await navigate(page, 'Assignments');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigate(page, 'Home');
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await navigate(page, 'My documents');
  await navigate(page, 'Assignments');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await unlockWorkspace(page);
  await expect(
    page.getByRole('button', { name: /Dashboard-created draft Local science/ }),
  ).toContainText('draft');
});

test('teacher and student Home have distinct counts, priorities, draft visibility and feedback', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await ready(page);
  await page.evaluate(async () => {
    const modulePath = '/src/lib/storage.ts';
    const db = await import(modulePath);
    const document = (await db.listDocuments()).find((item: { trashed: boolean }) => !item.trashed);
    if (!document) throw new Error('Missing encrypted sample document');
    const fixtures = [
      {
        title: 'Private preparation',
        status: 'draft',
        className: 'Teacher-only planning',
        dueDate: '2026-10-01',
      },
      {
        title: 'Review earlier response',
        status: 'submitted',
        className: 'Science',
        dueDate: '2026-10-11',
      },
      {
        title: 'Review latest response',
        status: 'submitted',
        className: 'Science',
        dueDate: '2026-10-12',
      },
      { title: 'Due later', status: 'assigned', className: 'Math', dueDate: '2026-10-22' },
      { title: 'Due first', status: 'assigned', className: 'Math', dueDate: '2026-10-15' },
      {
        title: 'Read returned feedback',
        status: 'returned',
        className: 'Science',
        dueDate: '2026-10-25',
        feedback: 'Synthetic feedback: explain your evidence.',
      },
    ];
    for (const [index, assignment] of fixtures.entries())
      await db.saveAssignment({
        id: crypto.randomUUID(),
        documentId: document.id,
        instructions: 'Synthetic local coursework; no school is connected.',
        createdAt: 1800000000000 + index,
        ...assignment,
      });
  });
  const teacher = page.getByRole('region', { name: 'Teacher dashboard', exact: true });
  await count(teacher, 'To review', 2);
  await count(teacher, 'Drafts', 1);
  await count(teacher, 'Ready for students', 2);
  await expect(teacher.locator('.role-home-row strong')).toHaveText([
    'Review latest response',
    'Review earlier response',
    'Private preparation',
  ]);
  await expect(teacher.getByText('Teacher-only planning', { exact: true })).toBeVisible();
  await accessible(page);
  await role(page, 'student');
  const student = page.getByRole('region', { name: 'Student dashboard', exact: true });
  await count(student, 'To do', 2);
  await count(student, 'With feedback', 1);
  await count(student, 'Submitted locally', 2);
  await expect(student.locator('.role-home-row strong')).toHaveText([
    'Read returned feedback',
    'Due first',
    'Due later',
  ]);
  await expect(page.getByText('Private preparation', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Teacher-only planning', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create assignment', exact: true })).toHaveCount(0);
  await accessible(page);
  await student.getByRole('button', { name: /Read returned feedback.*Read feedback/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Read returned feedback', exact: true }),
  ).toContainText('Synthetic feedback: explain your evidence.');
  await page.getByRole('button', { name: 'Mark as submitted locally', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Draft\s/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create assignment', exact: true })).toHaveCount(0);
  await expect(page.getByText('Private preparation', { exact: true })).toHaveCount(0);
  await navigate(page, 'Home');
  await count(student, 'With feedback', 0);
  await count(student, 'Submitted locally', 3);
  await page.reload();
  await unlockWorkspace(page);
  await expect(student).toBeVisible();
  await count(student, 'Submitted locally', 3);
  expect(failures).toEqual([]);
});

test('real bound coursework is labelled and excluded from generic document actions and draft sources', async ({
  page,
}) => {
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
  await ready(page);
  await page.goto('/canvas/work');
  await unlockWorkspace(page);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await page.goto('/#home');
  await unlockWorkspace(page);
  const name = 'Synthetic Canvas coursework';
  await expect(
    page
      .getByRole('region', { name: 'Recent documents', exact: true })
      .getByText(name, { exact: true }),
  ).toHaveCount(0);
  await navigate(page, 'My documents');
  // The title shares a button with the label, so select the stable explicit checkbox/menu labels.
  const checkbox = page.getByRole('checkbox', { name: `Select ${name}`, exact: true });
  await expect(checkbox).toBeDisabled();
  await expect(page.getByText('Canvas-linked · open from Canvas', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all documents', exact: true }).check();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Move to folder']);
  await page.getByRole('heading', { name: 'My documents', exact: true }).click();
  await page.getByRole('button', { name: /^Synthetic Canvas coursework Canvas-linked/ }).click();
  await expect(
    page.getByText(
      'Open this assignment from its Canvas activity to continue. Your saved work remains on this device.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('.document-editor')).toHaveCount(0);
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await expect(page.getByText('Canvas-linked · open from Canvas', { exact: true })).toBeVisible();
  await navigate(page, 'Home');
  await page.getByRole('button', { name: 'Create assignment', exact: true }).click();
  await expect(
    page
      .getByRole('combobox', { name: 'Document', exact: true })
      .getByRole('option', { name, exact: true }),
  ).toHaveCount(0);
  expect(fixture.state.sourceReads).toBe(1);
});
