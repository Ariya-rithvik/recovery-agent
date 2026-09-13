/**
 * T2 — Calibration: is the model's predicted uplift the uplift we actually get?
 *
 *   node src/calibration.mjs
 *
 * A model can rank correctly and still be badly calibrated: it might say +30pp
 * and deliver +8pp, in which case every dollar of budget was allocated against a
 * number nobody should have trusted. Qini measures ORDER. This measures LEVEL.
 *
 * Method — the standard uplift-calibration plot, and it needs no ground truth:
 *   1. sort the held-out experiment rows by PREDICTED uplift
 *   2. cut into deciles
 *   3. inside each decile, observed uplift = (treated conversion rate)
 *                                          − (control conversion rate)
 *   4. plot predicted against observed; on the diagonal means calibrated
 *
 * Step 3 is why this works on real data: both arms exist inside every decile
 * because assignment was randomised, so the difference is an unbiased estimate
 * of the true effect for that slice. A merchant can run this on their own test.
 *
 * REFUSAL RULE: any decile with fewer than MIN_PER_ARM in either arm returns
 * null with a reason instead of a number. A decile of 12 people produces a
 * difference that swings tens of points on noise, and printing it would be
 * worse than printing nothing.
 */

export const MIN_PER_ARM = 30;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Bootstrap interval on the observed difference of two rates. */
function bootDiff(treated, control, draws = 500, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let d = 0; d < draws; d++) {
    let a = 0, b = 0;
    for (let i = 0; i < treated.length; i++) a += treated[(rnd() * treated.length) | 0];
    for (let i = 0; i < control.length; i++) b += control[(rnd() * control.length) | 0];
    out.push(a / treated.length - b / control.length);
  }
  out.sort((x, y) => x - y);
  const at = q => out[Math.max(0, Math.min(out.length - 1, Math.floor(q * out.length)))];
  return [at(0.05), at(0.95)];
}

/**
 * @param rows [{ score, treated: 0|1, converted: 0|1 }]  score = PREDICTED uplift
 * @returns {{ deciles: Array, summary: object }}
 */
export function calibrationByDecile(rows, { bins = 10 } = {}) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const size = Math.ceil(sorted.length / bins);
  const deciles = [];

  for (let i = 0; i < bins; i++) {
    const slice = sorted.slice(i * size, (i + 1) * size);
    if (!slice.length) continue;
    const t = slice.filter(r => r.treated === 1);
    const c = slice.filter(r => r.treated === 0);
    const predicted = mean(slice.map(r => r.score));

    if (t.length < MIN_PER_ARM || c.length < MIN_PER_ARM) {
      deciles.push({
        decile: i + 1, n: slice.length, predicted: +predicted.toFixed(4),
        observed: null, ci90: null, n_treated: t.length, n_control: c.length,
        reason: `n=${t.length} treated / ${c.length} control; need ${MIN_PER_ARM} per arm`,
      });
      continue;
    }

    const tv = t.map(r => r.converted);
    const cv = c.map(r => r.converted);
    const observed = mean(tv) - mean(cv);
    deciles.push({
      decile: i + 1, n: slice.length, predicted: +predicted.toFixed(4),
      observed: +observed.toFixed(4), ci90: bootDiff(tv, cv).map(v => +v.toFixed(4)),
      n_treated: t.length, n_control: c.length, reason: null,
    });
  }

  const usable = deciles.filter(d => d.observed !== null);
  const errs = usable.map(d => Math.abs(d.predicted - d.observed));
  // Does the observed effect rise with the predicted one? That is the property
  // the targeting actually depends on, and it survives a level bias.
  const mono = usable.length > 2
    ? corr(usable.map(d => d.predicted), usable.map(d => d.observed))
    : null;

  return {
    deciles,
    summary: {
      usable_deciles: usable.length + ' of ' + deciles.length,
      mean_abs_error: usable.length ? +(mean(errs) * 100).toFixed(2) + 'pp' : null,
      rank_correlation: mono === null ? null : +mono.toFixed(3),
      // A model that over-promises across the board is a specific, fixable fault.
      bias: usable.length
        ? +(mean(usable.map(d => d.predicted - d.observed)) * 100).toFixed(2) + 'pp'
        : null,
      verdict: !usable.length ? 'not enough data in any decile'
        : mean(errs) < 0.05 ? 'well calibrated'
          : mono !== null && mono > 0.8 ? 'ranks correctly but over/under-states the level'
            : 'poorly calibrated — do not size a budget from these numbers',
    },
  };
}

function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/* ───────────────────────────── rendering ───────────────────────────── */

const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + 'pp';

/** Predicted on the left, observed as a bar, so drift is visible at a glance. */
export function render(cal, { width = 34 } = {}) {
  const L = [];
  const usable = cal.deciles.filter(d => d.observed !== null);
  const max = Math.max(0.05, ...usable.flatMap(d => [Math.abs(d.predicted), Math.abs(d.observed)]));

  L.push('  decile      n   predicted    observed   90% interval');
  L.push('  ' + '-'.repeat(66));
  for (const d of cal.deciles) {
    if (d.observed === null) {
      L.push('  ' + String(d.decile).padStart(4) + String(d.n).padStart(7)
        + pct(d.predicted).padStart(12) + '           —   ' + d.reason);
      continue;
    }
    const bar = barFor(d.observed, max, width);
    L.push('  ' + String(d.decile).padStart(4) + String(d.n).padStart(7)
      + pct(d.predicted).padStart(12) + pct(d.observed).padStart(12)
      + '   [' + pct(d.ci90[0]) + ', ' + pct(d.ci90[1]) + ']');
    L.push('       ' + bar);
  }
  L.push('  ' + '-'.repeat(66));
  const s = cal.summary;
  L.push('  usable ' + s.usable_deciles + ' · mean abs error ' + s.mean_abs_error
    + ' · bias ' + s.bias + ' · rank corr ' + s.rank_correlation);
  L.push('  ' + s.verdict.toUpperCase());
  return L.join('\n');
}

function barFor(v, max, width) {
  const half = Math.floor(width / 2);
  const n = Math.round((Math.abs(v) / max) * half);
  return v >= 0
    ? ' '.repeat(half) + '|' + '#'.repeat(n)
    : ' '.repeat(half - n) + '#'.repeat(n) + '|';
}

/* ───────────────────────────── CLI ───────────────────────────── */

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('calibration.mjs')) {
  const { generateCustomers, featurise, rng } = await import('./twin.mjs');
  const { fitUplift } = await import('./uplift.mjs');

  const people = generateCustomers({ n: 14000, seed: 11 });
  const feats = new Map(people.map(c => [c.id, featurise(c)]));
  const r = rng(99);
  const shuffled = [...people].sort(() => r() - 0.5);
  const train = shuffled.slice(0, 7000);
  const holdout = shuffled.slice(7000);

  const rct = (group, seed) => {
    const g = rng(seed);
    return group.map(c => {
      const treated = g() < 0.5 ? 1 : 0;
      const p = treated ? c.truth.p1 : c.truth.p0;
      return { x: feats.get(c.id).x, treated, converted: g() < p ? 1 : 0 };
    });
  };

  const model = fitUplift(rct(train, 4242));
  if (!model.ok) { console.error(model.reason); process.exit(1); }

  const rows = rct(holdout, 777).map(r2 => ({ ...r2, score: model.uplift(r2.x) }));
  const cal = calibrationByDecile(rows);

  console.log('');
  console.log('  CALIBRATION — predicted uplift vs what the held-out arm actually delivered');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + holdout.length + ' customers never seen in training, randomised 50/50');
  console.log('');
  console.log(render(cal));
  console.log('');
}
