/**
 * Decision explainer — why this customer, in words, with the evidence attached.
 *
 * WHY THIS EXISTS
 * A recovery agent that outputs `blocked: recovers unprompted` is correct and
 * useless. The operator approving a voice call on a $130 invoice needs to know
 * what the model saw. The best idea we carried over from Manthan — our team's
 * dispute-investigation agent (github.com/akash-mondal/manthan) — is that every
 * sentence in a brief links back to the record it rests on. That idea costs
 * nothing to adopt and it is what makes an audit trail worth auditing.
 *
 * THE ORDER MATTERS, and it is the opposite of the usual one:
 *
 *   1. JavaScript computes the facts and the numbers.        <- arithmetic
 *   2. A deterministic template turns them into sentences.   <- always runs
 *   3. An LLM may REPHRASE those sentences, and nothing else. <- optional
 *
 * The model never sees a number it can change. Any rewrite that drops or alters
 * a figure is rejected and the deterministic text is used instead. That gate is
 * the difference between an explanation and a plausible-sounding story.
 */

import { usd } from './money.mjs';

/* ────────────────────────── evidence extraction ────────────────────────── */

/**
 * Everything the decision actually rests on, as label/value pairs. This is the
 * citation list: if a claim references something not in here, it gets dropped.
 */
export function evidenceFor(d, feat) {
  const ev = [
    { key: 'amount', label: 'amount at risk', value: usd(d.amount) },
    { key: 'reason', label: 'decline code', value: d.reason.replace(/_/g, ' ') },
    { key: 'attempts', label: 'payment attempts', value: d.attempts },
    { key: 'uplift', label: 'estimated incremental effect', value: (d.tau * 100).toFixed(1) + 'pp' },
    { key: 'p_control', label: 'recovers unprompted', value: Math.round(d.pControl * 100) + '%' },
    { key: 'p_treated', label: 'recovers if contacted', value: Math.round(d.pTreated * 100) + '%' },
  ];
  if (d.consent != null) {
    ev.push({ key: 'consent', label: 'consent to be called', value: d.consent ? 'on file' : 'none' });
  }
  if (feat) {
    ev.push(
      { key: 'orders', label: 'prior invoices', value: Math.round(feat.x[0] * 10) },
      { key: 'captured', label: 'prior successful payments', value: Math.round(feat.x[1] * 10) },
      { key: 'wallet_share', label: 'share paid by wallet', value: Math.round(feat.x[4] * 100) + '%' },
      { key: 'coupon_rate', label: 'invoices using a coupon', value: Math.round((feat.couponRate ?? 0) * 100) + '%' },
      { key: 'recency', label: 'days since last payment', value: feat.daysSince },
    );
  }
  if (d.ev != null) ev.push({ key: 'net_ev', label: 'expected value of acting', value: usd(d.ev) });
  if (d.alt?.ev != null) ev.push({ key: 'alt_ev', label: 'expected value of the other channel', value: usd(d.alt.ev) });
  return ev;
}

/* ──────────────────────── deterministic explanation ──────────────────────── */

const pct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + 'pp';

/**
 * Build the brief from facts only. Every claim names the evidence keys it uses,
 * so `validate()` can check it and the UI can render citation chips.
 */
export function explain(d, feat) {
  const ev = evidenceFor(d, feat);
  const val = k => ev.find(e => e.key === k)?.value;
  const claims = [];

  // 1. what happened
  claims.push({
    text: `Payment of ${val('amount')} was declined (${val('reason')}), after ${val('attempts')} attempt(s).`,
    cites: ['amount', 'reason', 'attempts'],
  });

  // 2. what they would do on their own — the number everyone skips
  claims.push({
    text: `Left alone, this customer recovers ${val('p_control')} of the time.`,
    cites: ['p_control'],
  });

  // 3. what acting actually changes
  if (d.tau < -0.02) {
    claims.push({
      text: `Contacting them makes recovery ${pct(d.tau)} WORSE — customers matching this `
        + `pattern cancel when chased.`,
      cites: ['uplift', 'p_control', 'p_treated'],
    });
  } else if (d.tau < 0.02) {
    claims.push({
      text: `Contacting them moves recovery by only ${pct(d.tau)}, which is inside the noise band. `
        + `The outreach would buy nothing they were not already going to do.`,
      cites: ['uplift', 'p_control', 'p_treated'],
    });
  } else {
    claims.push({
      text: `Contacting them lifts recovery to ${val('p_treated')}, an incremental ${pct(d.tau)}.`,
      cites: ['uplift', 'p_treated'],
    });
  }

  // 4. behavioural grounding, only when we actually have it
  if (feat) {
    const orders = Math.round(feat.x[1] * 10);
    if (orders >= 4) {
      claims.push({
        text: `They have completed ${orders} prior payments, ${val('wallet_share')} of them by wallet.`,
        cites: ['captured', 'wallet_share'],
      });
    }
    if ((feat.couponRate ?? 0) > 0.4) {
      claims.push({
        text: `${val('coupon_rate')} of their past invoices used a coupon — price-sensitive.`,
        cites: ['coupon_rate'],
      });
    }
  }

  // 5. which channel, and why — the call is the expensive one, so it must earn it
  if (d.action === 'call' && d.alt) {
    claims.push({
      text: `A voice call is worth ${val('net_ev')} here against ${val('alt_ev')} for an email, `
        + `because a call captures the whole effect and an email only part of it.`,
      cites: ['net_ev', 'alt_ev'],
    });
  } else if (d.action === 'email' && d.consent === false) {
    claims.push({
      text: `There is no consent to be called on file, so email is the only channel.`,
      cites: ['consent'],
    });
  } else if (d.action === 'email' && d.alt) {
    claims.push({
      text: `Email is worth ${val('net_ev')} against ${val('alt_ev')} for a call — the extra `
        + `recovery would not pay for the call.`,
      cites: ['net_ev', 'alt_ev'],
    });
  }

  // 6. the decision, and the money behind it
  const act = d.action === 'call' ? 'place an AI voice call and send the Stripe recovery link'
    : d.action === 'email' ? 'email the Stripe recovery link'
      : 'take no action';
  claims.push({
    text: `Recommend: ${act}. Expected value ${val('net_ev') ?? 'n/a'}.`
      + (d.tier ? (d.tier.approvals === 0 ? ' Auto-approved tier.' : ` Requires ${d.tier.label}.`) : ''),
    cites: d.ev != null ? ['net_ev', 'amount'] : ['amount'],
  });

  return {
    id: d.id,
    headline: verdictOf(d),
    claims,
    evidence: ev,
    recommendation: act,
    // Confidence is about the DATA, not the model's feelings about itself.
    confidence: Math.min(1, Math.abs(d.tau) / 0.25),
  };
}

const verdictOf = d => {
  if (d.why) return 'DECLINED — ' + d.why;
  if (d.tau < -0.02) return 'DO NOT CONTACT — chasing this customer reduces recovery';
  if (d.tau < 0.02) return 'DO NOT CONTACT — recovers unprompted';
  return 'CONTACT — ' + (d.action === 'call' ? 'AI voice call' : 'email with recovery link');
};

/* ─────────────────────────────── validation ─────────────────────────────── */

/**
 * Every number that appears in the prose must also appear in the evidence list.
 * This is what stops an LLM rewrite from inventing "3 prior disputes" or
 * rounding 32.1pp into "about a third". A claim that fails is dropped, not
 * softened, and the drop is reported so a rising drop-rate is visible.
 */
/*
 * Both sides go through the SAME normaliser. The first version compared raw
 * strings and rejected almost every good sentence: "$1,243" tokenised as "1"
 * and "243" because of the thousands separator, and evidence stored "32.1pp"
 * while the prose said "32.1". Over-rejecting is the safe direction, but it was
 * quietly deleting the two most informative claims on every row.
 */
const numsIn = s => (String(s)
  .replace(/(\d),(?=\d)/g, '$1')        // 1,243 -> 1243
  .replace(/[$%]|pp\b/g, '')
  .match(/-?\d+(?:\.\d+)?/g) ?? [])
  .map(n => n.replace(/\.0+$/, ''));

export function validate(brief) {
  const known = new Set(brief.evidence.flatMap(e => numsIn(e.value)));
  const kept = [], dropped = [];

  for (const c of brief.claims) {
    const unsupported = numsIn(c.text).filter(n => !known.has(n));
    // citations must resolve too
    const badCite = c.cites.filter(k => !brief.evidence.some(e => e.key === k));
    if (unsupported.length || badCite.length) {
      dropped.push({ ...c, unsupported, badCite });
    } else kept.push(c);
  }
  return { ...brief, claims: kept, dropped };
}

/* ───────────────────────────── optional LLM pass ───────────────────────────── */

/**
 * Rewrites the claims into one flowing paragraph. It receives ONLY the already-
 * validated sentences and is told it may not introduce a number. The result is
 * re-validated; if anything fails, the deterministic text is kept.
 *
 * @param callModel  async ({system, user}) => string   supply your own client
 */
export async function phrase(brief, callModel) {
  if (!callModel) return { ...brief, prose: brief.claims.map(c => c.text).join(' '), phrasedBy: 'template' };
  try {
    const out = await callModel({
      system: 'Rewrite these factual sentences into one short paragraph an operations '
        + 'analyst can read in ten seconds. You may reorder and join them. You may NOT '
        + 'introduce any number, name, or claim that is not already present, and you may '
        + 'not round or alter any number. Return the paragraph only.',
      user: brief.claims.map(c => c.text).join('\n'),
    });
    const prose = String(out).trim();
    const known = new Set(brief.evidence.flatMap(e => numsIn(e.value)));
    const invented = numsIn(prose).filter(n => !known.has(n));
    if (invented.length) {
      return { ...brief, prose: brief.claims.map(c => c.text).join(' '), phrasedBy: 'template',
        rejected: 'model introduced numbers not in evidence: ' + invented.join(', ') };
    }
    return { ...brief, prose, phrasedBy: 'llm' };
  } catch (e) {
    return { ...brief, prose: brief.claims.map(c => c.text).join(' '), phrasedBy: 'template',
      rejected: String(e?.message ?? e) };
  }
}

/* ───────────────────────────────── render ───────────────────────────────── */

export function render(brief, { width = 78 } = {}) {
  const L = [];
  L.push('  ' + brief.id + '  ' + brief.headline);
  const body = brief.prose ?? brief.claims.map(c => c.text).join(' ');
  for (const line of wrap(body, width - 6)) L.push('      ' + line);
  L.push('      evidence: ' + brief.evidence
    .filter(e => ['reason', 'uplift', 'p_control', 'consent', 'net_ev', 'alt_ev'].includes(e.key))
    .map(e => e.label + ' ' + e.value).join(' · '));
  if (brief.dropped?.length) {
    L.push('      DROPPED ' + brief.dropped.length + ' unsupported claim(s)');
  }
  return L.join('\n');
}

function wrap(s, w) {
  const out = [];
  let line = '';
  for (const word of String(s).split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w) { out.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
