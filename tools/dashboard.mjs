/**
 * tools/dashboard.mjs — turn out/run.json into a single-file HTML dashboard.
 *
 * Run `npm run demo` or `npm run live` first; this only reads what that run
 * already wrote. No network, no dependencies, no data invented here — every
 * number on the page is copied from run.json, which is itself copied from the
 * batch's own JavaScript variables at the moment it ran.
 *
 *   node tools/dashboard.mjs
 *   node tools/dashboard.mjs --open     also opens it in the default browser
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_JSON = join(ROOT, 'out', 'run.json');
const OUT_HTML = join(ROOT, 'out', 'dashboard.html');

if (!existsSync(RUN_JSON)) {
  console.error('\n  out/run.json not found. Run `npm run demo` or `npm run live` first.\n');
  process.exit(1);
}
const run = JSON.parse(readFileSync(RUN_JSON, 'utf8'));

/* ─────────────────────────────── helpers ─────────────────────────────── */

const usd = c => {
  const n = (Number(c) || 0) / 100;
  const abs = Math.abs(n);
  const body = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return (n < 0 ? '-$' : '$') + body;
};
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = n => (n >= 0 ? '+' : '') + n.toFixed(1) + 'pp';

const STATE_LABEL = { live: 'LIVE', partial: 'PARTIAL', dry_run: 'DRY RUN', not_set: 'NOT SET', failed: 'FAILED', awaiting_approval: 'WAITING' };
const STATE_CLASS = { live: 'ok', partial: 'warn', dry_run: 'muted', not_set: 'muted', failed: 'bad', awaiting_approval: 'warn' };

/* ─────────────────────────────── sections ─────────────────────────────── */

function kpis() {
  const best = run.table.find(r => r.policy.startsWith('This agent')) ?? run.table.at(-1);
  const nothing = run.table.find(r => r.policy === 'Contact nobody');
  const vsNothing = best.net_margin_cents - (nothing?.net_margin_cents ?? 0);
  return `
  <section class="kpis">
    <div class="kpi"><div class="kpi-label">Failed payments</div><div class="kpi-value">${run.batch.failed_payments.toLocaleString()}</div><div class="kpi-sub">${usd(run.batch.at_risk_cents)} at risk</div></div>
    <div class="kpi"><div class="kpi-label">Contacted</div><div class="kpi-value">${best.contacted.toLocaleString()}</div><div class="kpi-sub">${best.calls} calls · ${best.contacted - best.calls} emails</div></div>
    <div class="kpi accent"><div class="kpi-label">Net margin vs nothing</div><div class="kpi-value">${vsNothing >= 0 ? '+' : ''}${usd(vsNothing)}</div><div class="kpi-sub">${usd(best.net_margin_cents)} total</div></div>
    <div class="kpi"><div class="kpi-label">Model quality (Qini)</div><div class="kpi-value">${run.qini.toFixed(1)}</div><div class="kpi-sub">0 = no better than random</div></div>
    <div class="kpi"><div class="kpi-label">Budget used</div><div class="kpi-value">${usd(run.audit_summary ? (run.table.find(r=>r.policy.startsWith('This agent'))?.spent_cents) : 0)}</div><div class="kpi-sub">of ${usd(run.budget_cents)}</div></div>
  </section>`;
}

function reasons() {
  const entries = Object.entries(run.by_reason ?? {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(e => e[1]), 1);
  return `
  <section class="card">
    <h2>1 · Detect — why payments failed</h2>
    <div class="bars">
      ${entries.map(([k, v]) => `
        <div class="bar-row">
          <div class="bar-label">${esc(k.replace(/_/g, ' '))}</div>
          <div class="bar-track"><div class="bar-fill reason" style="width:${(v / max * 100).toFixed(1)}%"></div></div>
          <div class="bar-value">${v}</div>
        </div>`).join('')}
    </div>
  </section>`;
}

function table() {
  const best = run.table.find(r => r.policy.startsWith('This agent'))?.policy;
  const maxNet = Math.max(...run.table.map(r => r.net_margin_cents), 1);
  return `
  <section class="card">
    <h2>2 · Measure — every policy, same held-out data</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Policy</th><th>Contacted</th><th>Calls</th><th>Spent</th><th>Net margin</th><th>vs nothing</th></tr></thead>
        <tbody>
          ${run.table.map(r => `
            <tr class="${r.policy === best ? 'highlight' : ''}">
              <td>${esc(r.policy)}</td>
              <td class="num">${r.contacted.toLocaleString()}</td>
              <td class="num">${r.calls.toLocaleString()}</td>
              <td class="num">${usd(r.spent_cents)}</td>
              <td class="num">
                <div class="net-cell">
                  <div class="net-bar" style="width:${(Math.max(0,r.net_margin_cents) / maxNet * 100).toFixed(1)}%"></div>
                  <span>${usd(r.net_margin_cents)}</span>
                </div>
              </td>
              <td class="num ${r.vs_nothing_cents >= 0 ? 'pos' : 'neg'}">${r.vs_nothing_cents >= 0 ? '+' : ''}${usd(r.vs_nothing_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </section>`;
}

function archetypes() {
  if (!run.archetypes?.length) return '';
  return `
  <section class="card">
    <h2>3 · Who actually got contacted <span class="muted-inline">— the model was never told these labels</span></h2>
    <div class="archetype-grid">
      ${run.archetypes.map(a => `
        <div class="archetype">
          <div class="archetype-head">
            <strong>${esc(a.archetype.replace(/_/g, ' '))}</strong>
            <span class="tau ${a.true_uplift_pp >= 0 ? 'pos' : 'neg'}">${pct(a.true_uplift_pp)}</span>
          </div>
          <div class="archetype-note">${esc(a.note)}</div>
          <div class="archetype-bars">
            <div class="mini-bar-row"><span>contacted</span><div class="mini-track"><div class="mini-fill contacted" style="width:${a.contacted_pct}%"></div></div><span>${a.contacted_pct}%</span></div>
            <div class="mini-bar-row"><span>called</span><div class="mini-track"><div class="mini-fill called" style="width:${a.called_pct}%"></div></div><span>${a.called_pct}%</span></div>
          </div>
          <div class="archetype-count">${a.in_batch.toLocaleString()} in batch</div>
        </div>`).join('')}
    </div>
  </section>`;
}

function decisions() {
  if (!run.decisions?.length) return '';
  return `
  <section class="card">
    <h2>4 · Decisions — every number checked against evidence</h2>
    <div class="decision-list">
      ${run.decisions.map(d => `
        <div class="decision ${d.verdict}">
          <div class="decision-head">
            <span class="decision-id">${esc(d.id)}</span>
            <span class="decision-headline ${d.verdict === 'approved' ? 'pos' : 'muted-inline'}">${esc(d.headline)}</span>
            ${d.tier ? `<span class="pill">${esc(d.tier.replace('_', '-'))}</span>` : ''}
          </div>
          <p class="decision-prose">${esc(d.prose)}</p>
          <div class="evidence-row">
            ${d.evidence.map(e => `<span class="evidence-chip" title="${esc(e.label)}">${esc(e.label)}: <b>${esc(e.value)}</b></span>`).join('')}
          </div>
        </div>`).join('')}
    </div>
  </section>`;
}

function governance() {
  const p = run.pacer ?? {};
  return `
  <section class="card">
    <h2>5 · Governance</h2>
    <div class="gov-grid">
      <div class="gov-stat"><div class="gov-num">${p.halted ?? 0}</div><div class="gov-label">halted</div></div>
      <div class="gov-stat"><div class="gov-num">${p.nudged ?? 0}</div><div class="gov-label">nudged</div></div>
      <div class="gov-stat warn"><div class="gov-num">${p.on_propensity_list_halted ?? 0}</div><div class="gov-label">would halt on propensity list</div></div>
      <div class="gov-stat"><div class="gov-num">${esc((p.batch ?? '').toUpperCase())}</div><div class="gov-label">batch verdict</div></div>
    </div>
    ${p.sample_halts?.length ? `
      <div class="halt-samples">
        ${p.sample_halts.map(s => `<div class="halt-sample"><span class="pill bad">HALT</span> ${esc(s.id)} — ${esc(s.message)}</div>`).join('')}
      </div>` : ''}
  </section>`;
}

function integrations() {
  const entries = Object.entries(run.integrations ?? {});
  return `
  <section class="card">
    <h2>6 · Integrations — what actually happened</h2>
    <div class="integration-grid">
      ${entries.map(([k, v]) => `
        <div class="integration ${STATE_CLASS[v.state] ?? 'muted'}">
          <div class="integration-head">
            <span class="integration-name">${esc(k)}</span>
            <span class="state-badge ${STATE_CLASS[v.state] ?? 'muted'}">${esc(STATE_LABEL[v.state] ?? v.state ?? '—')}</span>
          </div>
          <div class="integration-detail">${esc(v.detail ?? '—')}</div>
        </div>`).join('')}
    </div>
  </section>`;
}

function scar() {
  const s = run.scar;
  if (!s) return `<section class="card"><h2>7 · Learning (Scar)</h2><p class="muted-inline">Scar did not run on this batch.</p></section>`;
  const checks = Array.isArray(s.checks) ? s.checks : [];
  const passed = checks.filter(c => c.pass ?? c.ok ?? c.passed).length;
  return `
  <section class="card">
    <h2>7 · Learning — Scar</h2>
    <div class="scar-row">
      <span class="state-badge ${s.accepted ? 'ok' : 'bad'}">${s.accepted ? 'ACCEPTED' : 'REJECTED'}</span>
      <span>skill <b>${esc(s.skill ?? '?')}</b></span>
      <span>${passed}/${checks.length} checks</span>
      ${s.before && s.after ? `<span>${s.before.handled}/${s.before.total} → <b>${s.after.handled}/${s.after.total}</b> failures handled</span>` : ''}
    </div>
  </section>`;
}

/* ─────────────────────────────── page ─────────────────────────────── */

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Recovery Agent — run dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0d1117; --bg-card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e;
    --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 32px; max-width: 1200px; margin-inline: auto;
  }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; flex-wrap: wrap; gap: 8px; }
  header h1 { margin: 0; font-size: 22px; }
  header .mode { font-family: Consolas, Menlo, monospace; font-size: 13px; color: var(--muted); }
  .mode.live { color: var(--ok); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .kpi.accent { border-color: var(--ok); background: linear-gradient(180deg, rgba(63,185,80,.08), transparent); }
  .kpi-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .kpi-value { font-size: 26px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 20px 22px; margin-bottom: 18px; }
  .card h2 { margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); }
  .muted-inline { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .table-wrap { overflow-x: auto; }
  th { text-align: left; color: var(--muted); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.highlight { background: rgba(63,185,80,.08); }
  tr.highlight td:first-child { color: var(--ok); font-weight: 600; }
  td.pos { color: var(--ok); } td.neg { color: var(--bad); }
  .net-cell { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .net-bar { height: 6px; background: var(--accent); border-radius: 3px; min-width: 2px; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: grid; grid-template-columns: 160px 1fr 40px; align-items: center; gap: 10px; font-size: 13px; }
  .bar-track { background: rgba(255,255,255,.06); border-radius: 4px; height: 10px; overflow: hidden; }
  .bar-fill.reason { background: var(--accent); height: 100%; border-radius: 4px; }
  .bar-value { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
  .archetype-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
  .archetype { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .archetype-head { display: flex; justify-content: space-between; align-items: center; font-size: 14px; margin-bottom: 4px; }
  .tau.pos { color: var(--ok); } .tau.neg { color: var(--bad); }
  .archetype-note { font-size: 12px; color: var(--muted); margin-bottom: 10px; min-height: 30px; }
  .mini-bar-row { display: grid; grid-template-columns: 60px 1fr 34px; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .mini-track { background: rgba(255,255,255,.06); border-radius: 3px; height: 6px; overflow: hidden; }
  .mini-fill.contacted { background: var(--accent); height: 100%; }
  .mini-fill.called { background: var(--ok); height: 100%; }
  .archetype-count { font-size: 11px; color: var(--muted); margin-top: 8px; text-align: right; }
  .decision-list { display: flex; flex-direction: column; gap: 12px; }
  .decision { border: 1px solid var(--border); border-left: 3px solid var(--muted); border-radius: 6px; padding: 12px 14px; }
  .decision.approved { border-left-color: var(--ok); }
  .decision.declined { border-left-color: var(--bad); }
  .decision-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .decision-id { font-family: Consolas, Menlo, monospace; color: var(--accent); font-size: 13px; }
  .decision-headline { font-weight: 600; font-size: 13px; }
  .decision-headline.pos { color: var(--ok); }
  .pill { font-size: 10px; text-transform: uppercase; letter-spacing: .03em; background: rgba(255,255,255,.08); padding: 2px 8px; border-radius: 999px; color: var(--muted); }
  .pill.bad { background: rgba(248,81,73,.15); color: var(--bad); }
  .decision-prose { font-size: 13px; line-height: 1.5; margin: 6px 0 10px; color: #c9d1d9; }
  .evidence-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .evidence-chip { font-size: 11px; background: rgba(88,166,255,.08); border: 1px solid rgba(88,166,255,.2); border-radius: 999px; padding: 3px 9px; color: var(--muted); }
  .evidence-chip b { color: var(--text); }
  .gov-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .gov-stat { text-align: center; border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .gov-stat.warn { border-color: var(--warn); }
  .gov-num { font-size: 22px; font-weight: 700; }
  .gov-label { font-size: 11px; color: var(--muted); text-transform: uppercase; margin-top: 2px; }
  .halt-samples { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
  .halt-sample { display: flex; gap: 8px; align-items: center; }
  .integration-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .integration { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .integration.ok { border-color: rgba(63,185,80,.4); }
  .integration.bad { border-color: rgba(248,81,73,.4); }
  .integration-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .integration-name { font-weight: 600; font-size: 13px; text-transform: capitalize; }
  .state-badge { font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 3px 9px; border-radius: 999px; }
  .state-badge.ok { background: rgba(63,185,80,.15); color: var(--ok); }
  .state-badge.warn { background: rgba(210,153,34,.15); color: var(--warn); }
  .state-badge.bad { background: rgba(248,81,73,.15); color: var(--bad); }
  .state-badge.muted { background: rgba(139,148,158,.15); color: var(--muted); }
  .integration-detail { font-size: 11px; color: var(--muted); word-break: break-all; font-family: Consolas, Menlo, monospace; }
  .scar-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; font-size: 13px; }
  footer { text-align: center; color: var(--muted); font-size: 11px; margin-top: 24px; }
  @media (max-width: 640px) { body { padding: 16px; } .bar-row { grid-template-columns: 110px 1fr 34px; } }
</style>
</head>
<body>
<header>
  <h1>Recovery Agent</h1>
  <div class="mode ${run.mode === 'live' ? 'live' : ''}">${esc(run.mode).toUpperCase().replace('_', ' ')} · generated ${new Date(run.generated_at).toLocaleString()} · customers ${esc(run.customers)}</div>
</header>
${kpis()}
${reasons()}
${table()}
${archetypes()}
${decisions()}
${governance()}
${integrations()}
${scar()}
<footer>Generated from out/run.json by tools/dashboard.mjs — every number here is copied, not recomputed.</footer>
</body>
</html>`;

writeFileSync(OUT_HTML, html);
console.log('\n  wrote ' + OUT_HTML.replace(ROOT + '\\', '').replace(ROOT + '/', '') + '\n');

if (process.argv.includes('--open')) {
  const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener === 'start' ? 'cmd' : opener, opener === 'start' ? ['/c', 'start', '', OUT_HTML] : [OUT_HTML],
    { shell: false, stdio: 'ignore', detached: true }).unref();
}
