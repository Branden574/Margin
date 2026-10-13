process.stdout.write('RENEWAL_CHILD_STARTED\n');
const { renewCanvasPostgresCertificate } = await import(
  '../../apps/api/src/canvas-local/certificate-maintenance.ts'
);
process.stdout.write('RENEWAL_IMPORTED\n');
const [root, phase] = process.argv.slice(2);
await renewCanvasPostgresCertificate(root, {
  afterPhase: async (value) => {
    if (value !== phase) return;
    process.stdout.write('RENEWAL_PAUSED\n');
    await new Promise(() => setInterval(() => {}, 1000));
  },
});
