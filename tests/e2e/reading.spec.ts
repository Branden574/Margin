import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { unlockWorkspace } from './vault-helpers';

const FIRST_PAGE = 'First page reading evidence. Keep this sentence on page one.';
const LAST_PAGE = 'Final page reading evidence. The blank page has no inherited text.';

async function openReadingFixture(page: Page) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(FIRST_PAGE, { x: 40, y: 740, size: 14, font });
  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]).drawText(LAST_PAGE, { x: 40, y: 740, size: 14, font });
  await page.goto('/#documents');
  await unlockWorkspace(page);
  await page.getByLabel('Choose documents to upload', { exact: true }).setInputFiles({
    name: 'Synthetic reading regression.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page
    .getByRole('button', { name: 'Synthetic reading regression PDF document', exact: true })
    .click();
  const opener = page.getByRole('button', { name: 'Read aloud', exact: true });
  await expect(opener).toBeEnabled();
  await opener.click();
  const panel = page.getByRole('complementary', { name: 'Reading tools', exact: true });
  await expect(panel.getByRole('heading', { name: 'Read this page', exact: true })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toHaveText(
    FIRST_PAGE,
  );
  return panel;
}

test('reading view extracts the current PDF page, clears blank pages, copies text and unmounts', async ({
  page,
  context,
}) => {
  // Browser text/clipboard behavior is real. This case does not simulate or assert speech output.
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const panel = await openReadingFixture(page);
  const accessibility = await new AxeBuilder({ page })
    .include('.editor-reading-panel')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  const previous = page.getByRole('button', { name: 'Previous page', exact: true });
  const copy = panel.getByRole('button', { name: 'Copy text', exact: true });
  await copy.click();
  await expect(page.getByText('Page text copied.', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).trim())
    .toBe(FIRST_PAGE);

  await next.click();
  const blank = page.getByRole('region', { name: 'Page 2 text', exact: true });
  await expect(blank).toHaveAttribute('aria-busy', 'false');
  await expect(blank).toContainText('This page has no selectable text.');
  await expect(blank).not.toContainText(FIRST_PAGE);
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toHaveCount(0);
  await expect(copy).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Play page', exact: true })).toBeDisabled();

  await next.click();
  await expect(page.getByRole('region', { name: 'Page 3 text', exact: true })).toHaveText(
    LAST_PAGE,
  );
  await expect(next).toBeDisabled();
  await copy.click();
  await expect
    .poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).trim())
    .toBe(LAST_PAGE);

  await previous.click();
  await expect(blank).toContainText('This page has no selectable text.');
  await expect(blank).not.toContainText(LAST_PAGE);
  await previous.click();
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toHaveText(
    FIRST_PAGE,
  );
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  const opener = page.getByRole('button', { name: 'Read aloud', exact: true });
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.reading-page-overlay')).toHaveCount(0);

  await page.getByRole('button', { name: 'View page text', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toHaveText(
    FIRST_PAGE,
  );
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Page 1 text', exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('reading appearance changes text size, tint and ruler while focus mode preserves page navigation', async ({
  page,
}) => {
  const panel = await openReadingFixture(page);
  const text = page.getByRole('region', { name: 'Page 1 text', exact: true });
  await panel.getByText('Reading appearance', { exact: true }).click();
  const accessibility = await new AxeBuilder({ page })
    .include('.editor-reading-panel')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await panel.getByLabel('Reading text size', { exact: true }).selectOption('150');
  await expect(text).toHaveCSS('font-size', '24px');
  await panel.getByLabel('Reading color overlay', { exact: true }).selectOption('blue');
  const overlay = page.locator('.reading-page-overlay');
  await expect(overlay).toHaveClass(/reading-tint-blue/);
  await expect(text).toHaveClass(/reading-tint-blue/);
  await expect(overlay).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(overlay).toHaveCSS('pointer-events', 'none');

  await panel.getByLabel('Reading ruler on the PDF', { exact: true }).check();
  await panel.getByLabel('Reading ruler height', { exact: true }).selectOption('120');
  const ruler = page.locator('.reading-ruler');
  await expect(ruler).toHaveCSS('height', '120px');
  const position = panel.getByRole('slider', { name: 'Reading ruler position', exact: true });
  await position.focus();
  await position.press('Home');
  await expect(position).toHaveValue('0');
  await expect(ruler).toHaveCSS('top', '0px');
  await position.press('End');
  await expect(position).toHaveValue('100');
  await expect
    .poll(async () => {
      const rulerBox = await ruler.boundingBox(),
        overlayBox = await overlay.boundingBox();
      if (!rulerBox || !overlayBox) return Number.POSITIVE_INFINITY;
      return Math.abs(rulerBox.y + rulerBox.height - overlayBox.y - overlayBox.height);
    })
    .toBeLessThan(2);

  const focus = panel.getByRole('button', { name: 'Focus mode', exact: true });
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeHidden();
  await expect(
    page.getByRole('complementary', { name: 'Document pages', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Page 2 text', exact: true })).toContainText(
    'This page has no selectable text.',
  );
  await focus.press('Escape');
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeVisible();
  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Exit focus mode', exact: true }).click();
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByRole('complementary', { name: 'Document pages', exact: true }),
  ).toBeVisible();
  await panel.getByLabel('Reading ruler on the PDF', { exact: true }).uncheck();
  await expect(ruler).toHaveCount(0);
  await panel.getByLabel('Reading color overlay', { exact: true }).selectOption('none');
  await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(overlay).toHaveCount(0);
});

test('375 by 812 viewport emulation keeps reading controls reachable without widening the document view', async ({
  page,
}) => {
  // This is Chromium viewport emulation, not a physical phone or touch-input qualification.
  await page.setViewportSize({ width: 375, height: 812 });
  const panel = await openReadingFixture(page);
  const opener = page.getByRole('button', { name: 'Read aloud', exact: true });
  await expect(opener).toBeInViewport({ ratio: 1 });
  await expect(opener).toHaveAccessibleName('Read aloud');
  await expect(panel).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.right <= window.innerWidth &&
          box.top >= 0 &&
          box.bottom <= window.innerHeight &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
    )
    .toBe(true);

  const canvasArea = page.locator('.editor-canvas-area');
  const documentViewWidth = await canvasArea.evaluate((element) => element.clientWidth);
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(opener).toBeFocused();
  await expect(opener).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() => canvasArea.evaluate((element) => element.clientWidth))
    .toBe(documentViewWidth);
  await opener.click();
  await panel.getByText('Reading appearance', { exact: true }).click();
  const tint = panel.getByLabel('Reading color overlay', { exact: true });
  const ruler = panel.getByLabel('Reading ruler on the PDF', { exact: true });
  await tint.selectOption('sepia');
  await ruler.check();
  await expect(page.locator('.reading-page-overlay')).toHaveClass(/reading-tint-sepia/);
  await expect(page.locator('.reading-ruler')).toBeAttached();

  const focus = panel.getByRole('button', { name: 'Focus mode', exact: true });
  for (const control of [
    panel.getByRole('button', { name: 'Play page', exact: true }),
    panel.getByLabel('Reading voice', { exact: true }),
    panel.getByLabel('Reading speed', { exact: true }),
    focus,
    tint,
    panel.getByLabel('Reading text size', { exact: true }),
    ruler,
    panel.getByRole('slider', { name: 'Reading ruler position', exact: true }),
    panel.getByLabel('Reading ruler height', { exact: true }),
    panel.getByRole('button', { name: 'Copy text', exact: true }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    const controlBox = await control.boundingBox(),
      panelBox = await panel.boundingBox();
    if (!controlBox || !panelBox) throw new Error('Reading control is not rendered');
    expect(controlBox.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  }

  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed', 'true');
  const exit = page.getByRole('button', { name: 'Exit focus mode', exact: true });
  await expect(exit).toBeInViewport({ ratio: 1 });
  await exit.click();
  await expect(focus).toHaveAttribute('aria-pressed', 'false');
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('spinbutton', { name: 'Current page', exact: true })).toHaveValue(
    '1',
  );
  await expect(page.locator('.editor-paper canvas')).toBeVisible();
  await expect
    .poll(() => canvasArea.evaluate((element) => element.clientWidth))
    .toBe(documentViewWidth);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});
