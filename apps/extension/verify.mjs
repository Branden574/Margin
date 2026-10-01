import { readFile, access } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
if (
  manifest.manifest_version !== 3 ||
  manifest.host_permissions?.length ||
  manifest.content_scripts?.length
)
  throw new Error('Unexpected extension permission or execution surface.');
for (const file of ['popup.html', 'popup.css', 'popup.js', 'background.js', 'urls.js'])
  await access(new URL(file, import.meta.url));
console.log(
  'Margin MV3 extension files and permission surface validated. Load apps/extension unpacked in Chrome.',
);
