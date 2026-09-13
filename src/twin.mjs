/**
 * Behavioural Twin — customer event stream to behavioural state.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * The customers are synthetic, and they are labelled as such everywhere. What is
 * real is the *method*: events in, behavioural features out, and a held-out
 * evaluation that never peeks at the generator. Point `featurise()` at a
 * merchant's real Stripe webhooks and nothing downstream changes.
 *
 * The generator deliberately encodes a fact most targeting systems get wrong:
 * a customer's probability of converting is NOT the same as their responsiveness
 * to an intervention. Some customers convert anyway (discounting them burns
 * margin), and some convert LESS when pushed. Both exist in real merchant data;
 * both are invisible to a propensity model.
 */

/* ────────────────────────────── rng ────────────────────────────── */

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = x => Math.max(0.001, Math.min(0.999, x));
const sig = z => 1 / (1 + Math.exp(-z));

/* ─────────────────────── latent customer world ─────────────────────── */

/**
 * Behavioural archetypes, with how each responds to a discount nudge. `aov` is in
 * cents, the unit Stripe amounts use; `wallet` is the share of payments made with
 * Apple Pay / Google Pay / Link rather than a typed card.
 */
export const ARCHETYPES = {
  habitual: {
    label: 'Habitual buyer', weight: 0.16,
    base: { engagement: 0.82, wallet: 0.90, evening: 0.75, recency: 0.85, priceSens: 0.22, aov: 3800 },
    note: 'Buys anyway. A discount here is margin you simply gave away.',
  },
  persuadable: {
    label: 'Persuadable', weight: 0.24,
    base: { engagement: 0.55, wallet: 0.70, evening: 0.60, recency: 0.45, priceSens: 0.72, aov: 2600 },
    note: 'On the fence and price-aware. This is who the budget is for.',
  },
  browser: {
    label: 'Window shopper', weight: 0.28,
    base: { engagement: 0.28, wallet: 0.55, evening: 0.40, recency: 0.25, priceSens: 0.55, aov: 1500 },
    note: 'Rarely converts either way. Spending on them changes almost nothing.',
  },
  dormant: {
    label: 'Dormant', weight: 0.19,
    base: { engagement: 0.12, wallet: 0.48, evening: 0.35, recency: 0.05, priceSens: 0.40, aov: 1900 },
    note: 'Long gone. Reactivation rarely pays for itself.',
  },
  loyalist_sensitive: {
    label: 'Discount-averse loyalist', weight: 0.13,
    base: { engagement: 0.70, wallet: 0.86, evening: 0.68, recency: 0.72, priceSens: 0.06, aov: 6800 },
    note: 'Discounting teaches them to wait, and cheapens the brand. Pushing HURTS.',
  },
};

/**
 * Price sensitivity drives the causal effect but is not directly observable, so
 * it has to leave a trace a merchant can actually see. It does, in reality:
 * price-sensitive customers hunt for coupons, and premium buyers never do.
 * Without this the model is being asked an unanswerable question.
 */
const couponPropensity = priceSens => Math.min(0.92, Math.pow(priceSens, 1.4) * 1.15);

/**
 * Ground truth the model is never shown. p_control is the conversion rate with
 * no intervention; tau is the causal effect of the discount, which is negative
 * for the discount-averse.
 */
function groundTruth(kind, f, rnd) {
  const p0 = clamp01(sig(
    -1.15 + 2.4 * f.engagement + 1.5 * f.recency + 0.5 * f.wallet - 0.35 * f.priceSens
  ) + (rnd() - 0.5) * 0.05);

  let tau;
  switch (kind) {
    case 'persuadable':        tau = 0.16 + 0.16 * f.priceSens + (rnd() - 0.5) * 0.04; break;
    case 'habitual':           tau = 0.012 + (rnd() - 0.5) * 0.02; break;   // already buying
    case 'browser':            tau = 0.030 + (rnd() - 0.5) * 0.03; break;   // barely moves
    case 'dormant':            tau = 0.018 + (rnd() - 0.5) * 0.02; break;
    case 'loyalist_sensitive': tau = -0.075 + (rnd() - 0.5) * 0.03; break;  // pushing backfires
    default:                   tau = 0;
  }
  return { p0, p1: clamp01(p0 + tau), tau };
}

/* ────────────────────── event stream generation ────────────────────── */

const pad = n => String(n).padStart(4, '0');

/**
 * Emit an event history per customer, the way a merchant would actually
 * accumulate it: orders, payment attempts, method, failures, retries, sessions.
 * featurise() must derive everything it needs from THIS, never from the latent
 * parameters - that separation is what keeps the benchmark honest.
 */
export function generateCustomers({ n = 4000, seed = 7, months = 6 } = {}) {
  const rnd = rng(seed);
  const kinds = Object.keys(ARCHETYPES);
  const out = [];

  for (let i = 0; i < n; i++) {
    let r = rnd(), kind = kinds[kinds.length - 1], acc = 0;
    for (const k of kinds) { acc += ARCHETYPES[k].weight; if (r <= acc) { kind = k; break; } }
    const b = ARCHETYPES[kind].base;

    const jitter = s => Math.max(0, Math.min(1, s + (rnd() - 0.5) * 0.22));
    const f = {
      engagement: jitter(b.engagement), wallet: jitter(b.wallet), evening: jitter(b.evening),
      recency: jitter(b.recency), priceSens: jitter(b.priceSens),
      aov: Math.round(b.aov * (0.75 + rnd() * 0.5)),
    };

    // events: orders over the window, each with a payment attempt chain
    const orders = Math.max(0, Math.round(f.engagement * 9 * (0.5 + rnd())));
    const events = [];
    let lastDay = null;
    for (let o = 0; o < orders; o++) {
      const day = Math.floor(rnd() * months * 30);
      const walletChosen = rnd() < f.wallet;
      const amount = Math.round(f.aov * (0.6 + rnd() * 0.8));
      const hour = rnd() < f.evening ? 20 + Math.floor(rnd() * 3) : 9 + Math.floor(rnd() * 9);
      const coupon = rnd() < couponPropensity(f.priceSens);
      events.push({ day, hour, type: 'invoice.created', amount, coupon });
      if (coupon) events.push({ day, hour, type: 'customer.discount.created', amount });
      // a typed card fails materially more often than a wallet - the merchant sees this directly
      const failP = walletChosen ? 0.06 : 0.23;
      if (rnd() < failP) {
        events.push({ day, hour, type: 'invoice.payment_failed', method: walletChosen ? 'wallet' : 'card', amount });
        if (rnd() < 0.55 + 0.3 * f.engagement) {
          events.push({ day, hour: hour + 1, type: 'invoice.paid', method: 'wallet', amount, retry: true });
          lastDay = Math.max(lastDay ?? 0, day);
        }
      } else {
        events.push({ day, hour, type: 'invoice.paid', method: walletChosen ? 'wallet' : 'card', amount });
        lastDay = Math.max(lastDay ?? 0, day);
      }
    }
    const sessions = Math.round(orders * (1.5 + rnd() * 2.5) + rnd() * 4);
    for (let s = 0; s < sessions; s++) {
      const day = Math.floor(rnd() * months * 30);
      const abandoned = rnd() > f.engagement;       // same draw order as the original generator
      events.push({ day, type: abandoned ? 'checkout.session.expired' : 'checkout.session.completed', abandoned });
    }
    events.sort((x, y) => x.day - y.day);

    const gt = groundTruth(kind, f, rnd);
    out.push({
      id: 'C' + pad(i), kind, events,
      lastPurchaseDay: lastDay, windowDays: months * 30,
      truth: gt,                                   // NEVER passed to the model
      aovTrue: f.aov,
    });
  }
  return out;
}

/* ───────────────────────── behavioural features ───────────────────────── */

export const FEATURE_NAMES = [
  'orders', 'captured', 'failed', 'retry_rate', 'wallet_share', 'evening_share',
  'abandon_rate', 'log_aov', 'recency', 'frequency',
  'coupon_rate',          // the observable proxy for price sensitivity
  'coupon_x_aov',         // premium-and-never-discounts vs bargain-hunting
  'aov_sq',               // the response curve is not linear in order value
];

/**
 * Events -> behavioural state. This is the only thing the model ever sees, and
 * every value here is something a merchant genuinely has from Stripe webhooks
 * plus their own checkout logs.
 */
export function featurise(c) {
  const ev = c.events;
  const orders = ev.filter(e => e.type === 'invoice.created');
  const captured = ev.filter(e => e.type === 'invoice.paid');
  const failed = ev.filter(e => e.type === 'invoice.payment_failed');
  const retries = captured.filter(e => e.retry);
  const checkouts = ev.filter(e => e.type.startsWith('checkout.session.'));
  const abandoned = checkouts.filter(e => e.abandoned);
  const wallet = captured.filter(e => e.method === 'wallet');
  const evening = orders.filter(e => e.hour >= 20);
  const amounts = captured.map(e => e.amount);
  const aov = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const daysSince = c.lastPurchaseDay == null ? c.windowDays : c.windowDays - c.lastPurchaseDay;
  const couponRate = orders.length ? orders.filter(e => e.coupon).length / orders.length : 0;
  const logAov = Math.log1p(aov) / 10;

  return {
    id: c.id,
    aov: Math.round(aov),
    daysSince,
    couponRate: +couponRate.toFixed(3),
    x: [
      orders.length / 10,
      captured.length / 10,
      failed.length / 5,
      failed.length ? retries.length / failed.length : 0,
      captured.length ? wallet.length / captured.length : 0.5,
      orders.length ? evening.length / orders.length : 0.5,
      checkouts.length ? abandoned.length / checkouts.length : 0.5,
      logAov,
      1 - daysSince / c.windowDays,
      captured.length / Math.max(1, c.windowDays / 30),
      couponRate,
      couponRate * logAov,
      logAov * logAov,
    ],
  };
}

/** Standardise columns so gradient descent behaves. Returns the scaler too. */
export function standardise(rows) {
  const d = rows[0].length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) sd[j] += (r[j] - mean[j]) ** 2 / rows.length;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const apply = r => r.map((v, j) => (v - mean[j]) / sd[j]);
  return { apply, mean, sd };
}
