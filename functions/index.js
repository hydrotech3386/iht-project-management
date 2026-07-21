/**
 * Cloud Functions for the Project Management app.
 *
 * extractItems       — reads a PO/BQ/Quotation and returns its scope line items.
 * extractProjectInfo — reads the same kind of document and returns just the
 *                       header info (project name / client / site) so the
 *                       "New Project" form can auto-fill itself.
 *
 * Both use Claude's document reading. The Anthropic API key lives in Secret
 * Manager and never reaches the browser.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-sonnet-5';
const MAX_BYTES = 20 * 1024 * 1024; // Anthropic caps document/image payloads

/* ---- shared: fetch a document from Storage and build an Anthropic content block ---- */
async function fetchDocBlock(storagePath, fileName) {
  let buffer, contentType;
  try {
    const file = admin.storage().bucket().file(storagePath);
    const [meta] = await file.getMetadata();
    contentType = meta.contentType || '';
    if (Number(meta.size) > MAX_BYTES) {
      throw new HttpsError('invalid-argument',
        `File is ${(meta.size / 1048576).toFixed(1)}MB — the limit is 20MB.`);
    }
    [buffer] = await file.download();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error('storage read failed', e);
    throw new HttpsError('not-found', 'Could not read the document from storage.');
  }

  const b64 = buffer.toString('base64');
  if (contentType === 'application/pdf' || /\.pdf$/i.test(fileName || '')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  }
  if (contentType.startsWith('image/')) {
    return { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } };
  }
  throw new HttpsError('invalid-argument',
    `Unsupported file type "${contentType || 'unknown'}". Upload a PDF or an image.`);
}

/* ---- shared: call Claude with a document block + system prompt ---- */
async function callClaude(block, systemPrompt, userText, maxTokens) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: [block, { type: 'text', text: userText }] }]
      })
    });
  } catch (e) {
    console.error('anthropic request failed', e);
    throw new HttpsError('unavailable', 'Could not reach the AI service.');
  }
  if (!res.ok) {
    const errText = await res.text();
    console.error('anthropic error', res.status, errText.slice(0, 800));
    if (res.status === 401) throw new HttpsError('failed-precondition', 'The Anthropic API key is invalid.');
    if (res.status === 429) throw new HttpsError('resource-exhausted', 'AI rate limit hit — try again shortly.');
    throw new HttpsError('internal', `AI service error (${res.status}).`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  return { text, data };
}

function requirePmStoragePath(storagePath) {
  if (!storagePath || typeof storagePath !== 'string') {
    throw new HttpsError('invalid-argument', 'storagePath is required.');
  }
  // only ever read this app's own namespace
  if (!storagePath.startsWith('pm/projects/')) {
    throw new HttpsError('permission-denied', 'Path outside this app.');
  }
}

/* =====================================================================
   extractItems — scope-of-work line items
   ===================================================================== */
const ITEMS_SYSTEM_PROMPT = `You extract the scope-of-work line items from construction and M&E procurement documents (Purchase Orders, Bills of Quantities, Quotations) for a Malaysian water/wastewater engineering company.

Return ONLY a JSON object of this exact shape:
{"items":[{"no":string,"description":string,"qty":number|null,"unit":string,"rate":number|null,"amount":number|null,"section":string}]}

Rules:
- One entry per priced/scoped line item, in document order.
- "no" is the item's own reference number or code exactly as printed in the document's "Item"/"No."/"Ref" column (e.g. "1.1.1", "2.3", "A", "PC-3", "1.3.14") — copy it verbatim, including any letters or dot-numbering, as a string. Leave it "" only if the document truly prints no number/code for that row. Never invent or renumber — this must match the source document exactly so the app's item list lines up with the printed BQ/PO/quotation.
- "description" is the work/material description, cleaned of leading numbering (the numbering belongs in "no", not repeated in the description). Keep it specific (e.g. "Supply and install 5.5kW submersible pump").
- "qty" is the quantity as a number (null if absent). "unit" is the unit of measure ("set","nos","lot","m","m2", etc; "" if absent).
- "rate" is the UNIT rate in RM as a number, ONLY if a separate rate/unit-price figure is actually printed for that line. Leave it null if the document shows no rate column value for that row — do not compute or infer it.
- "amount" is the line TOTAL in RM, taken directly from an "Amount"/"Total"/"Total Amount" column if the document prints one for that row. This is very often present even when "rate" is blank (common for lump-sum "L/S"/"lot" items, or BQs that only show a rate once for a group of rows but print the amount per row). Extract "amount" independently of "rate" — never assume amount = qty × rate, read what is actually printed. Leave null only if truly no figure is shown for that row.
- If a cell literally says "N/A", "TBA", "included", "by others" or is blank, that field is null — do not invent a number.
- Never strip decimals: read exactly what is printed (e.g. 25.7, 44.8) — quantities are frequently non-integer.
- "section" is the heading/trade the item sits under (e.g. "Mechanical Works", "Primary Screen - Inlet Chamber"); "" if none. Use the most specific sub-heading, not just the top-level one.
- SKIP: section headers with no quantity/price of their own, subtotals, "TOTAL AMOUNT" carry-forward/brought-forward rows, grand totals, SST/GST/tax lines, discounts, page headers/footers, terms & conditions, and any commentary. Also skip "Previous Claim"/"This Claim"/"Total Claim" columns if the document has them — those are claim-tracking columns, not part of scope extraction.
- If a line is a provisional/PC sum, keep it as an item.
- If the document has no identifiable line items, return {"items":[]}.
Output raw JSON only — no markdown fences, no explanation.`;

/* Parse the model's JSON, tolerating code fences and — if the output was cut
   off at max_tokens — a truncated final object. Returns {items:[...]} or null. */
function parseItemsLoose(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 1. straight parse of the outermost object
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  const end = cleaned.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { /* fall through */ }
  }
  // 2. salvage: grab the items array and keep only the complete {...} objects
  const arrStart = cleaned.indexOf('[', cleaned.indexOf('"items"') >= 0 ? cleaned.indexOf('"items"') : 0);
  if (arrStart < 0) return null;
  const objs = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = arrStart + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { objs.push(JSON.parse(cleaned.slice(objStart, i + 1))); } catch (e) { /* skip broken */ }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return objs.length ? { items: objs } : null;
}

exports.extractItems = onCall(
  {
    region: 'asia-southeast1',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 540,   // large scanned BQs can take 3-4 min for the model
    memory: '1GiB',
    cors: true
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to use AI extraction.');

    const { storagePath, fileName } = request.data || {};
    requirePmStoragePath(storagePath);

    const block = await fetchDocBlock(storagePath, fileName);
    const { text, data } = await callClaude(block, ITEMS_SYSTEM_PROMPT,
      'Extract every scope line item from this document as JSON.', 32000);

    if (data.stop_reason === 'max_tokens') {
      console.warn('response hit max_tokens — will attempt to salvage complete items');
    }

    const parsed = parseItemsLoose(text);
    if (!parsed) {
      console.error('parse failed. stop_reason:', data.stop_reason, 'raw head:', text.slice(0, 500), 'raw tail:', text.slice(-500));
      throw new HttpsError('internal', 'The AI response could not be read. Try again.');
    }

    const num = v => {
      if (v === null || v === undefined || v === '') return '';
      const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : '';
    };
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .map(it => ({
        no: String(it.no || '').trim(),   // the source document's own item number/code, verbatim
        description: String(it.description || '').trim(),
        qty: num(it.qty),
        unit: String(it.unit || '').trim(),
        rate: num(it.rate),
        amount: num(it.amount),   // taken directly from the document, NOT derived from qty*rate
        section: String(it.section || '').trim()
      }))
      .filter(it => it.description);

    console.log(`extracted ${items.length} items from ${fileName || storagePath}`,
      'usage:', JSON.stringify(data.usage || {}));

    return { items, usage: data.usage || null };
  }
);

/* =====================================================================
   extractProjectInfo — header details for the "New Project" form
   ===================================================================== */
const INFO_SYSTEM_PROMPT = `You extract basic header information from a construction/M&E procurement document (Purchase Order, Bill of Quantities, or Quotation) for a Malaysian water/wastewater engineering company, so it can pre-fill a new project form.

Return ONLY a JSON object of this exact shape:
{"name":string|null,"client":string|null,"site":string|null}

Rules:
- "name" is a short, human project name/title — e.g. the project/contract title line, the subject of the quotation, or a short description of the works (NOT the document/quotation reference number alone, e.g. not "Q30677R"). Keep it concise, like something a person would type as a project name.
- "client" is the customer / employer / main contractor this document is addressed or quoted to — usually near "To:", "Attn:", "Client:", "Employer:", "Company:", or the addressee block at the top. Company name only, no address.
- "site" is the site/location name if stated (town, project location, site address short form) — null if not stated.
- If a field genuinely cannot be determined, use null. Do not guess or invent values.
Output raw JSON only — no markdown fences, no explanation.`;

exports.extractProjectInfo = onCall(
  {
    region: 'asia-southeast1',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 120,   // header-only: tiny output, so mostly just the doc-read time
    memory: '1GiB',
    cors: true
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to use AI extraction.');

    const { storagePath, fileName } = request.data || {};
    requirePmStoragePath(storagePath);

    const block = await fetchDocBlock(storagePath, fileName);
    const { text } = await callClaude(block, INFO_SYSTEM_PROMPT,
      'Extract the project name, client and site from this document as JSON.', 500);

    let parsed;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
      parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    } catch (e) {
      console.error('extractProjectInfo parse failed. raw:', text.slice(0, 400));
      // non-fatal — the form just won't auto-fill
      return { name: '', client: '', site: '' };
    }

    const clean = v => String(v || '').trim();
    const result = { name: clean(parsed.name), client: clean(parsed.client), site: clean(parsed.site) };
    console.log(`extracted project info from ${fileName || storagePath}:`, JSON.stringify(result));
    return result;
  }
);
