/**
 * tools/demo-check.mjs — run the demo the way a judge would: with every key deleted.
 *
 * WHY THIS EXISTS
 * The earlier version of this project carried placeholder payment keys for most
 * of its life without anyone noticing, because every test was a unit test that
 * needed no credential. The gap was not "a test failed" — it was "nothing ever
 * ran the demo end to end in a clean environment". This closes that.
 *
 * Every step runs with ALL the variables below deleted from the child process.
 * If a step passes here, it passes on a laptop that has never seen this repo's
 * .env. That is the claim the README makes, so it is the claim that gets tested.
 *
 *   node tools/demo-check.mjs
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/* Every variable any module reads. Deleted from the child env, not just blanked. */
const ENV_VARS = [
  'STRIPE_SECRET_KEY', 'STRIPE_IDEMPOTENCY_SALT',
  'RESEND_API_KEY', 'DEMO_EMAIL', 'EMAIL_FROM',
  'CALLE_API_KEY', 'CALLE_BASE_URL', 'CALLE_ALLOWED_NUMBERS', 'CALLE_REGION', 'CALLE_LOCALE',
  'DEMO_PHONE', 'CALL_COST_CENTS',
  'SLACK_WEBHOOK_URL', 'MERCHANT_NAME',
];

function scrubbed(extra = {}) {
  const e = { ...process.env };
  for (const k of ENV_VARS) delete e[k];
  return { ...e, ...extra };
}

function run(cmd, args, { timeout = 120000, env = scrubbed(), cwd } = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env, cwd });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: -1, out, err, timedOut: true }); }, timeout);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err, timedOut: false }); });
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), timedOut: false }); });
  });
}

let failed = 0;
const line = (name, ok, detail) => {
  console.log('  ' + name.padEnd(62) + (ok ? 'PASS' : 'FAIL'));
  if (!ok) { failed++; if (detail) console.log('        ' + String(detail).slice(0, 600).replace(/\n/g, '\n        ')); }
};

/** A step passes when the process exits 0 AND every `expect` string is present. */
async function step(name, args, expect = [], opts = {}) {
  const r = await run(process.execPath, args, opts);
  const text = r.out + r.err;
  const missing = expect.filter(s => !text.includes(s));
  const ok = r.code === 0 && !missing.length && !r.timedOut;
  line(name, ok, r.timedOut ? 'timed out' : r.code !== 0 ? 'exit ' + r.code + '\n' + text.slice(-400)
    : missing.map(m => 'missing from output: ' + JSON.stringify(m)).join('\n'));
  return r;
}

console.log('');
console.log('  DEMO CHECK — every step with all ' + ENV_VARS.length + ' env vars deleted');
console.log('  ' + '-'.repeat(60));
console.log('');
console.log('  A. the runbook, no keys present');

await step('npm run demo', ['src/recover.mjs'],
  ['DRY RUN', 'This agent (gated)', 'claims dropped for unsupported numbers: 0', 'ACCEPTED', 'INTEGRATIONS']);
await step('npm run dashboard (from that run)', ['tools/dashboard.mjs'], ['wrote out']);
{
  const html = readFileSync('out/dashboard.html', 'utf8');
  const openTags = (html.match(/<div/g) ?? []).length, closeTags = (html.match(/<\/div>/g) ?? []).length;
  line('dashboard.html: tags balanced, no unresolved templates',
    openTags === closeTags && openTags > 0 && !html.includes('${'),
    `div open=${openTags} close=${closeTags} unresolved=${(html.match(/\$\{/g) ?? []).length}`);
}
await step('npm test — policy ledger', ['src/policy.test.mjs'], ['25 passed, 0 failed']);
await step('npm test — pacer rules', ['src/pacer.test.mjs'], ['20 passed, 0 failed']);
await step('npm test — adapters (network disabled)', ['src/adapters.test.mjs'], ['24 passed, 0 failed']);
await step('npm run calibrate', ['src/calibration.mjs'], ['WELL CALIBRATED']);
await step('npm run bench', ['src/bench.mjs'], ['THESIS HOLDS']);

{
  const r = await run(process.execPath, ['src/index.ts', '--json'], { cwd: 'scar' });
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* reported below */ }
  line('scar --json: parses, skill accepted', r.code === 0 && j?.accepted === true, j ? 'accepted=' + j.accepted : r.err || r.out);
}
await step('generated skill replays its own failures', ['scar/generated/failed-payment-recovery-call/scripts/replay.mjs']);

console.log('');
console.log('  B. the paths that touch a credential, with none present');

{
  const r = await run(process.execPath, ['src/recover.mjs', '--live', '--approvers=asha,ravi']);
  const t = r.out + r.err;
  const notSet = (t.match(/^ {3}(Stripe|Resend|CALL-E|Slack)\b.*\bNOT SET\b/gm) ?? []).length;
  const anyLive = /^ {3}(Stripe|Resend|CALL-E|Slack)\b.{0,24}\bLIVE\b/m.test(t);
  line('--live with no keys: all four report NOT SET, none LIVE', r.code === 0 && notSet === 4 && !anyLive,
    `exit ${r.code}, NOT SET x${notSet}, any LIVE=${anyLive}\n` + t.slice(-500));
}
{
  const r = await run(process.execPath, ['src/recover.mjs', '--live'], { env: scrubbed({ STRIPE_SECRET_KEY: 'sk_live_placeholder_never_real' }) });
  const t = r.out + r.err;
  line('--live with a LIVE Stripe key: refused before any request',
    r.code === 0 && t.includes('refusing a LIVE Stripe key') && !/^ {3}Stripe.{0,24}\bLIVE\b/m.test(t), t.slice(-400));
}

console.log('');
console.log('  C. hygiene');

{
  const SKIP = new Set(['node_modules', '.git', 'out']);
  const hits = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|ts|md|json|txt|cmd|example)$/.test(name) && name !== '.env.example') continue;
      if (relative('.', p).replace(/\\/g, '/') === 'tools/demo-check.mjs') continue;
      const s = readFileSync(p, 'utf8');
      const m = s.match(/razorpay|₹|\bupi\b|aegis|paise/i);
      if (m) hits.push(relative('.', p) + ': ' + m[0]);
    }
  };
  walk('.');
  line('no leftover Razorpay / rupee / UPI / codename text', hits.length === 0, hits.join('\n'));
}

console.log('');
console.log('  ' + '-'.repeat(60));
if (failed === 0) {
  console.log('  ALL STEPS PASS WITH ZERO API KEYS.');
} else {
  console.log('  ' + failed + ' STEP(S) FAILED — do not record until these are green.');
}
console.log('');
process.exit(failed ? 1 : 0);
