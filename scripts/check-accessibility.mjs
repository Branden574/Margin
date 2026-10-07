import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
const certificate = new X509Certificate(
  await readFile(new URL('../.local/tls/cert.pem', import.meta.url)),
);
const publicKeyPin = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const browser = await chromium.launch({
  headless: true,
  args: [`--ignore-certificate-errors-spki-list=${publicKeyPin}`],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const reports = [];
async function check(view) {
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const report = {
    view,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    })),
  };
  reports.push(report);
  console.log(JSON.stringify(report));
}
try {
  await page.goto(process.env.MARGIN_CHECK_URL || 'https://127.0.0.1:5173');
  await page.getByLabel('Workspace passphrase', { exact: true }).waitFor();
  await check('vault-desktop');
  await page.screenshot({ path: '/tmp/margin-vault-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await check('vault-mobile');
  await page.screenshot({ path: '/tmp/margin-vault-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Workspace passphrase', { exact: true }).fill('test-only-a11y-passphrase');
  await page.getByLabel('Confirm passphrase', { exact: true }).fill('test-only-a11y-passphrase');
  await page.getByRole('button', { name: 'Create private workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'Ready for your next lesson, Alex?' }).waitFor();
  for (const theme of ['Light', 'Dark', 'High contrast']) {
    await page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: theme, exact: true }).click();
    await check(`${theme}-settings`);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Assignments', exact: true })
      .click();
    await check(`${theme}-assignments`);
    await page.locator('.sidebar').getByRole('button', { name: 'Home', exact: true }).click();
    await check(`${theme}-home`);
    if (theme === 'Light')
      await page.screenshot({ path: '/tmp/margin-home-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Open Cell structure & function', exact: true }).click();
    await page.getByRole('button', { name: 'Export encrypted file', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('canvas')?.width > 100);
    await check(`${theme}-editor`);
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
    if (theme !== 'Light') {
      await page.getByRole('button', { name: 'Lock workspace', exact: true }).click();
      await page.getByRole('heading', { name: 'Welcome back to Margin.' }).waitFor();
      await check(`vault-after-${theme}`);
      await page.locator('input[name=passphrase]').fill('test-only-a11y-passphrase');
      await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
      await page.getByRole('heading', { name: 'Ready for your next lesson, Alex?' }).waitFor();
    }
  }
} finally {
  await browser.close();
}
if (reports.some((r) => r.violations.length)) process.exitCode = 1;
