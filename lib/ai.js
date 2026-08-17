/* ============================================================
   AI estimating assistant.

   Two engines behind one door:

   1. LOCAL  — always available, no key, no internet. Reads the job
      description, pulls quantities and units out of the English, and
      matches each line against what THIS company has actually quoted
      and what is sitting on the shelf. Prices come from your own
      history, never from thin air.

   2. MODEL  — when an API key is configured, the same grounding facts
      go to the model along with the description. The model is told, in
      the strongest terms available, to price only from the supplied
      catalog and to flag anything it had to invent. Every line it
      returns is then re-checked against the catalog here: if we know
      the price of a thing, our number wins.

   The re-grounding in step 2 is the point. A quoting tool that lets a
   model make up a unit price is a tool that loses money quietly.
   ============================================================ */
'use strict';

const round2 = n => Math.round((Number(n) || 0) * 100 * (1 + Number.EPSILON)) / 100;

// ---------------------------------------------------------------- text handling
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'with', 'at', 'on', 'in',
  'per', 'plus', 'also', 'this', 'that', 'we', 'our', 'is', 'are', 'be', 'need', 'needs', 'needed',
  'please', 'job', 'work', 'them', 'it', 'as', 'by', 'from', 'about', 'approx', 'approximately']);

/**
 * Sizes and gauges ARE the item in this trade. 8" spiral duct and 10" spiral
 * duct share every word, so throwing away short numeric tokens leaves them
 * indistinguishable and the wrong one lands on the quote. Inch and foot marks
 * are folded into the number, fractions keep their slash, and anything
 * containing a digit survives the length filter.
 *
 * Both sides have to spell a size the same way or nothing matches: the
 * catalog says 5/8", the estimator types 5/8, and the shop says 5/8 inch.
 * All three collapse to 5/8 here.
 */
const tokens = s => String(s || '').toLowerCase()
  .replace(/(\d)\s*(?:"|inches\b|inch\b|in\b)/g, '$1')
  .replace(/(\d)\s*(?:'|feet\b|foot\b|ft\b)/g, '$1ft')
  .replace(/[^a-z0-9/ ]+/g, ' ')
  .split(/\s+/)
  .filter(w => w && !STOP.has(w) && (w.length > 2 || /\d/.test(w)));

/** Singular/plural collapse — "hoods" and "hood" are the same line item. */
const stem = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

const UNIT_WORDS = {
  ft: 'lf', foot: 'lf', feet: 'lf', lf: 'lf', 'linear feet': 'lf', lineal: 'lf',
  sqft: 'sqft', sf: 'sqft', 'sq ft': 'sqft', 'square feet': 'sqft',
  ea: 'ea', each: 'ea', pc: 'ea', pcs: 'ea', piece: 'ea', pieces: 'ea', unit: 'ea', units: 'ea',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  hr: 'hr', hrs: 'hr', hour: 'hr', hours: 'hr',
  sheet: 'sheet', sheets: 'sheet', stick: 'stick', sticks: 'stick',
  in: 'in', inch: 'in', inches: 'in', gal: 'gal', gallon: 'gal', gallons: 'gal',
  ls: 'ls', lot: 'ls',
};

/**
 * Pull a quantity and unit off the front (or middle) of a clause.
 * Handles "3 hoods", "40 ft of duct", "(2) curb adapters", "duct x 40 lf",
 * and bare feet marks like 8' — without eating the "24" in "24 gauge".
 */
function parseQty(clause) {
  const text = clause.trim();
  const unitAlt = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length)
    .map(u => u.replace(/ /g, '\\s')).join('|');

  const patterns = [
    new RegExp(`^\\(?(\\d+(?:\\.\\d+)?)\\)?\\s*(${unitAlt})\\b\\s*(?:of\\s+)?(.*)$`, 'i'),  // "40 lf of duct"
    new RegExp(`^\\(?(\\d+(?:\\.\\d+)?)\\)?\\s*(?:x|×)?\\s+(.*)$`, 'i'),                     // "3 exhaust hoods"
    new RegExp(`^(.*?)\\s*(?:x|×|qty)\\s*(\\d+(?:\\.\\d+)?)\\s*(${unitAlt})?\\.?$`, 'i'),    // "duct x 40 lf"
  ];

  let m = text.match(patterns[0]);
  if (m && m[3].trim()) return { qty: Number(m[1]), unit: UNIT_WORDS[m[2].toLowerCase().replace(/\s+/g, ' ')] || 'ea', desc: m[3].trim() };

  m = text.match(patterns[2]);
  if (m && m[1].trim()) return { qty: Number(m[2]), unit: m[3] ? (UNIT_WORDS[m[3].toLowerCase()] || 'ea') : 'ea', desc: m[1].trim() };

  m = text.match(patterns[1]);
  // a leading number that is really a gauge or a size ("16ga duct", "24x120 panel") is not a count
  if (m && m[2].trim() && !/^(ga|gauge|awg|["'x×])/i.test(m[2])) {
    return { qty: Number(m[1]), unit: 'ea', desc: m[2].trim() };
  }
  // "powder coat black 220 sqft" — quantity trailing. Only checked after the
  // leading forms, so the 8ft in "120 2x4 studs 8ft" stays a size, not a count.
  m = text.match(new RegExp(`^(.*?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${unitAlt})\\.?$`, 'i'));
  if (m && m[1].trim()) return { qty: Number(m[2]), unit: UNIT_WORDS[m[3].toLowerCase().replace(/\s+/g, ' ')] || 'ea', desc: m[1].trim() };

  return { qty: 1, unit: 'ea', desc: text };
}

/** Split a paragraph into the things a estimator would put on separate lines. */
function clauses(description) {
  return String(description || '')
    .split(/\r?\n|(?:^|\s)[-•*]\s+|;|,(?=\s*\(?\d)|(?:,| and )(?=\s*\d+\s*(?:ft|lf|ea|sq|sheets?|pcs?|hours?|lbs?)\b)/i)
    // strip bullets and "1." list markers only — a bare leading number is a
    // quantity, and eating it turns "120 studs" into one stud
    .map(s => s.replace(/^[\s\-•*]+/, '').replace(/^\d{1,2}[.)]\s+/, '').trim())
    .filter(s => s.length > 2);
}

// ---------------------------------------------------------------- matching
/**
 * Score a phrase against a catalog entry. Rare words count for more, so
 * "bollard" outweighs "steel" — otherwise every steel thing matches
 * every other steel thing.
 */
function buildMatcher(catalog) {
  const df = new Map();
  const docs = catalog.map(c => {
    // the unit belongs in the name: people write "14 drywall sheets", and
    // "sheet" lives on the catalog row's unit, not in its description
    const set = new Set([...tokens(c.desc), ...tokens(c.unit)].map(stem));
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
    return set;
  });
  const N = Math.max(1, catalog.length);
  const idf = t => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  return function match(phrase) {
    const q = [...new Set(tokens(phrase).map(stem))];
    if (!q.length) return null;
    const qWeight = q.reduce((s, t) => s + idf(t), 0);
    let best = null;
    for (let i = 0; i < catalog.length; i++) {
      const doc = docs[i];
      let hit = 0, hitCount = 0;
      for (const t of q) if (doc.has(t)) { hit += idf(t); hitCount++; }
      if (!hit) continue;
      // One shared word is not a match. "spiral duct" against "duct liner"
      // overlaps on "duct" and means something completely different — that
      // near-miss is how a quote goes out with the wrong item on it.
      if (q.length >= 2 && hitCount < 2) continue;
      // penalise catalog entries that are much longer than the query —
      // matching 2 words of a 12-word line is not really a match
      const coverage = hit / qWeight;
      const density = hit / [...doc].reduce((s, t) => s + idf(t), 0);
      const score = coverage * 0.7 + density * 0.3;
      if (!best || score > best.score) best = { entry: catalog[i], score: round2(score * 100) / 100 };
    }
    return best && best.score >= 0.42 ? best : null;
  };
}

/**
 * How old is this price? A material list imported from a spreadsheet carries
 * the date it was last confirmed, and a sheet-metal price from 2013 is not a
 * price — it is a number that used to be one.
 */
function staleNote(entry) {
  const d = entry.priced_on;
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  const years = (Date.now() - Date.parse(d + 'T12:00:00Z')) / (365.25 * 86400000);
  if (years < 2) return '';
  return ` Last priced ${d} — ${Math.floor(years)} years ago. Check it before you send this.`;
}

/**
 * Draft line items from a description using nothing but the company's
 * own numbers. This is the floor the model never drops below.
 */
function localDraft(description, ctx) {
  const match = buildMatcher(ctx.catalog);
  const items = [], assumptions = [], questions = [];
  let laborHours = 0;

  for (const clause of clauses(description)) {
    // an explicit hours callout is labor, not a line item
    const hrs = clause.match(/(\d+(?:\.\d+)?)\s*(?:man[- ])?(?:hours?|hrs?)\b/i);
    if (hrs && !/\$/.test(clause)) { laborHours += Number(hrs[1]); continue; }

    const { qty, unit, desc } = parseQty(clause);
    const found = match(desc);
    if (found) {
      const e = found.entry;
      items.push({
        desc: e.desc, qty, unit: e.unit || unit,
        unit_cost: round2(e.cost), unit_price: round2(e.price),
        source: e.source, confidence: found.score >= 0.7 ? 'high' : found.score >= 0.5 ? 'medium' : 'low',
        why: (e.source === 'catalog'
          ? `On the shelf at ${e.qty_on_hand ?? 0} ${e.unit || 'ea'} — priced from your material list.`
          : `You quoted this ${e.times} time${e.times === 1 ? '' : 's'}, last on ${e.last_on || 'a past job'} at $${round2(e.price)}.`) + staleNote(e),
        matched_from: clause,
      });
    } else {
      items.push({
        desc: desc.replace(/^\w/, c => c.toUpperCase()), qty, unit,
        unit_cost: 0, unit_price: 0, source: 'new', confidence: 'none',
        why: 'Nothing in your history matches this — put a price on it before sending.',
        matched_from: clause,
      });
      questions.push(`What do you charge for "${desc}"? It has not come up on a past quote.`);
    }
  }

  // labor: prefer what the text said, else scale from similar completed jobs
  if (!laborHours && ctx.similar.length) {
    const perK = ctx.similar.reduce((s, j) => s + (j.sold ? j.hours / j.sold * 1000 : 0), 0) / ctx.similar.length;
    const materials = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
    if (perK > 0 && materials > 0) {
      laborHours = Math.round(materials / 1000 * perK * 2) / 2;
      assumptions.push(`Labor set to ${laborHours} hrs, scaled from ${ctx.similar.length} similar completed job${ctx.similar.length === 1 ? '' : 's'} (${ctx.similar.map(j => j.job_number).join(', ')}). Check it.`);
    }
  }
  if (ctx.labor_variance_pct > 5 && laborHours) {
    assumptions.push(`Your labor estimates have run ${ctx.labor_variance_pct}% over on completed jobs — ${Math.round(laborHours * (1 + ctx.labor_variance_pct / 100) * 2) / 2} hrs is the honest number.`);
  }
  const stale = items.filter(i => /years ago/.test(i.why)).length;
  if (stale) assumptions.push(`${stale} line${stale === 1 ? ' uses a price' : 's use prices'} more than two years old. Re-check those before this goes out.`);
  const unpriced = items.filter(i => i.source === 'new').length;
  if (unpriced) assumptions.push(`${unpriced} line${unpriced === 1 ? '' : 's'} came back with no price — those are new to you.`);

  return { items, labor_hours: laborHours, assumptions, questions, mode: 'local' };
}

// ---------------------------------------------------------------- model provider
function config(settings) {
  return {
    key: settings.ai_api_key || process.env.ANTHROPIC_API_KEY || '',
    model: settings.ai_model || 'claude-sonnet-5',
    base: (settings.ai_base_url || 'https://api.anthropic.com').replace(/\/$/, ''),
    enabled: settings.ai_enabled !== '0',
  };
}

const ready = settings => { const c = config(settings); return Boolean(c.enabled && c.key); };

async function callModel(settings, { system, messages, tool, maxTokens = 2200 }) {
  const c = config(settings);
  if (!c.key) throw new Error('No AI key configured');
  const body = { model: c.model, max_tokens: maxTokens, system, messages };
  if (tool) { body.tools = [tool]; body.tool_choice = { type: 'tool', name: tool.name }; }

  const r = await fetch(`${c.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload?.error?.message || `AI request failed (HTTP ${r.status})`);
  if (tool) {
    const use = (payload.content || []).find(b => b.type === 'tool_use');
    if (!use) throw new Error('The model did not return a structured answer');
    return use.input;
  }
  return (payload.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ---------------------------------------------------------------- prompts
const HOUSE_RULES = `You are the in-house estimator for a construction and metal fabrication group.
You know sheet metal, structural steel, HVAC, welding, and general construction, and you write the way
a seasoned estimator writes: specific, short, no marketing language.

Hard rules, in order of importance:
1. PRICE ONLY FROM THE SUPPLIED CATALOG. If a line is not in the catalog, set unit_cost and unit_price
   to 0 and set source to "new". Never estimate, guess, average, or infer a price from general knowledge.
   An invented price is worse than a blank one — a blank gets noticed, a wrong number gets sent.
2. Write each line the way it would read on a customer proposal: what it is, size, gauge/grade, finish.
3. Break the scope into the lines a shop would actually buy and build, not one lump.
4. Say what you assumed and what you still need to know. Missing information is normal; hiding it is not.`;

const DRAFT_TOOL = {
  name: 'draft_quote',
  description: 'Return the drafted line items for this scope of work.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            desc: { type: 'string', description: 'Customer-facing line description' },
            qty: { type: 'number' },
            unit: { type: 'string', description: 'ea, lf, sqft, lb, sheet, hr, ls' },
            unit_cost: { type: 'number', description: 'Your cost. 0 if not in the catalog.' },
            unit_price: { type: 'number', description: 'Sell price. 0 if not in the catalog.' },
            source: { type: 'string', enum: ['history', 'catalog', 'new'] },
            why: { type: 'string', description: 'One sentence: where this line and its price came from.' },
          },
          required: ['desc', 'qty', 'unit', 'unit_cost', 'unit_price', 'source', 'why'],
        },
      },
      labor_hours: { type: 'number', description: 'Field/shop hours for the whole scope.' },
      labor_basis: { type: 'string', description: 'One sentence on how the hours were arrived at.' },
      assumptions: { type: 'array', items: { type: 'string' } },
      questions: { type: 'array', items: { type: 'string' }, description: 'What you need answered before this goes out.' },
      scope_summary: { type: 'string', description: 'A tightened-up scope paragraph for the proposal.' },
    },
    required: ['items', 'labor_hours', 'assumptions', 'questions'],
  },
};

function catalogBlock(ctx) {
  const rows = ctx.catalog.slice(0, 220).map(c => [
    c.desc, c.unit || 'ea', `cost ${c.cost}`, `price ${c.price}`,
    c.source === 'catalog' ? `on hand ${c.qty_on_hand ?? 0}` : `quoted ${c.times}× last ${c.last_on || '?'}`,
  ].join(' | '));
  return rows.join('\n') || '(this company has no priced history yet)';
}

/**
 * Every price the model hands back gets checked against the catalog. If we
 * know what the thing costs, our number replaces theirs — silently, because
 * the catalog is the source of truth and the model is a drafting aid.
 */
function reground(items, ctx) {
  const match = buildMatcher(ctx.catalog);
  return items.map(it => {
    const found = match(it.desc);
    const out = {
      desc: String(it.desc || '').slice(0, 200),
      qty: Number(it.qty) || 1,
      unit: String(it.unit || 'ea').slice(0, 12),
      unit_cost: round2(it.unit_cost),
      unit_price: round2(it.unit_price),
      source: ['history', 'catalog', 'new'].includes(it.source) ? it.source : 'new',
      why: String(it.why || '').slice(0, 300),
      confidence: 'medium',
    };
    if (found && found.score >= 0.5) {
      const e = found.entry;
      const drift = out.unit_price && e.price ? Math.abs(out.unit_price - e.price) / e.price : 0;
      out.unit_cost = round2(e.cost);
      out.unit_price = round2(e.price);
      out.source = e.source;
      out.confidence = found.score >= 0.7 ? 'high' : 'medium';
      out.why = (e.source === 'catalog'
        ? `Priced from your material list${e.qty_on_hand != null ? ` — ${e.qty_on_hand} ${e.unit || 'ea'} on hand` : ''}.`
        : `Your own price: quoted ${e.times}×, last on ${e.last_on || 'a past job'}.`) + staleNote(e);
      if (drift > 0.25) out.why += ` (The draft suggested $${round2(it.unit_price)} — your history won.)`;
    } else if (out.source !== 'new' && (out.unit_price || out.unit_cost)) {
      // claimed to come from history but nothing matches — do not trust the number
      out.unit_cost = 0; out.unit_price = 0; out.source = 'new'; out.confidence = 'none';
      out.why = 'No match in your price history, so this line was left unpriced on purpose.';
    } else {
      out.unit_cost = 0; out.unit_price = 0; out.source = 'new'; out.confidence = 'none';
      out.why = out.why || 'New to you — needs a price before this goes out.';
    }
    return out;
  });
}

async function draft(description, ctx, settings) {
  if (!ready(settings)) return localDraft(description, ctx);
  try {
    const out = await callModel(settings, {
      system: HOUSE_RULES,
      tool: DRAFT_TOOL,
      messages: [{
        role: 'user',
        content: `PRICED CATALOG — the only prices you may use (description | unit | cost | price | history):
${catalogBlock(ctx)}

SHOP CONTEXT
Company: ${ctx.company.name} (${ctx.company.trade})
Labor rate: $${ctx.labor_rate}/hr · Target margin: ${ctx.target_margin_pct}%
${ctx.labor_variance_pct ? `Past labor estimates ran ${ctx.labor_variance_pct}% against the clock.` : ''}
${ctx.similar.length ? `Similar completed jobs: ${ctx.similar.map(j => `${j.job_number} "${j.title}" — sold ${j.sold}, ${j.hours} hrs, ${j.margin_pct}% margin`).join('; ')}` : ''}
${ctx.client ? `Customer: ${ctx.client}` : ''}

SCOPE TO QUOTE
${description}`,
      }],
    });
    const items = reground(Array.isArray(out.items) ? out.items : [], ctx);
    if (!items.length) return localDraft(description, ctx);
    return {
      items,
      labor_hours: Number(out.labor_hours) || 0,
      labor_basis: out.labor_basis || '',
      scope_summary: out.scope_summary || '',
      assumptions: (out.assumptions || []).map(String).slice(0, 8),
      questions: (out.questions || []).map(String).slice(0, 8),
      mode: 'model',
    };
  } catch (e) {
    const local = localDraft(description, ctx);
    local.fallback_reason = e.message;
    return local;
  }
}

// ---------------------------------------------------------------- general assistance
const ASSISTANT_RULES = `You are the operations analyst for a construction and fabrication group.
You are given a live snapshot of the company's own books below. Answer from that snapshot and nothing else.

- Quote real numbers from the snapshot, with the job or invoice number attached, so the answer can be checked.
- If the snapshot does not contain the answer, say exactly that and name the screen where it would live.
  Do not extrapolate, and never invent a figure.
- Answer in a few sentences. This is read between site visits, not at a desk.
- Money as $12,450. Percentages to one decimal.`;

async function ask(question, snapshot, settings, thread = []) {
  if (!ready(settings)) return { answer: null, mode: 'unavailable' };
  const messages = [
    ...thread.slice(-6).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) })),
    { role: 'user', content: `LIVE COMPANY SNAPSHOT\n${JSON.stringify(snapshot, null, 1)}\n\nQUESTION\n${question}` },
  ];
  const answer = await callModel(settings, { system: ASSISTANT_RULES, messages, maxTokens: 1200 });
  return { answer, mode: 'model' };
}

/** Rewrite a rough scope note into something that can go in front of a customer. */
async function polish(text, kind, ctx, settings) {
  if (!ready(settings)) return { text: null, mode: 'unavailable' };
  const brief = kind === 'email'
    ? 'Rewrite this as a short, warm, professional note to a customer. No fluff, no superlatives, keep every fact.'
    : 'Rewrite this as the scope-of-work paragraph on a construction proposal. Specific, plain, no marketing language. Keep every number, size and material exactly as given. Do not add work that was not described.';
  const out = await callModel(settings, {
    system: `You write for ${ctx.company.name}, a ${ctx.company.trade} company. ${brief}
Return only the rewritten text — no preamble, no options, no commentary.`,
    messages: [{ role: 'user', content: String(text).slice(0, 6000) }],
    maxTokens: 900,
  });
  return { text: out, mode: 'model' };
}

module.exports = { draft, localDraft, ask, polish, ready, config, buildMatcher, parseQty, clauses, reground, tokens };
