/**
 * extractItems — reads a customer PO / BQ / Quotation stored in Firebase Storage
 * and returns its scope line items, using Claude's vision + document reading.
 *
 * Called from the Project Management web app (Items tab → "Extract items with AI").
 * The Anthropic API key lives in Secret Manager and never reaches the browser.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-sonnet-5';
const MAX_BYTES = 20 * 1024 * 1024; // Anthropic caps document/image payloads

const SYSTEM_PROMPT = `You extract the scope-of-work line items from construction and M&E procurement documents (Purchase Orders, Bills of Quantities, Quotations) for a Malaysian water/wastewater engineering company.

Return ONLY a JSON object of this exact shape:
{"items":[{"description":string,"qty":number|null,"unit":string,"rate":number|null,"section":string}]}

Rules:
- One entry per priced/scoped line item, in document order.
- "description" is the work/material description, cleaned of leading numbering. Keep it specific (e.g. "Supply and install 5.5kW submersible pump").
- "qty" is the quantity as a number (null if absent). "unit" is the unit of measure ("set","nos","lot","m","m2", etc; "" if absent).
- "rate" is the UNIT rate in RM as a number (null if absent). Never invent it. Strip currency symbols and thousands separators.
- "section" is the heading/trade the item sits under (e.g. "Mechanical Works", "Preliminaries"); "" if none.
- SKIP: section headers with no quantity/price of their own, subtotals, totals, grand totals, SST/GST/tax lines, discounts, page headers/footers, terms & conditions, and any commentary.
- If a line is a provisional/PC sum, keep it as an item.
- If the document has no identifiable line items, return {"items":[]}.
Output raw JSON only — no markdown fences, no explanation.`;

exports.extractItems = onCall(
  {
    region: 'asia-southeast1',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 300,
    memory: '1GiB',
    cors: true
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to use AI extraction.');
    }

    const { storagePath, fileName } = request.data || {};
    if (!storagePath || typeof storagePath !== 'string') {
      throw new HttpsError('invalid-argument', 'storagePath is required.');
    }
    // only ever read this app's own namespace
    if (!storagePath.startsWith('pm/projects/')) {
      throw new HttpsError('permission-denied', 'Path outside this app.');
    }

    // ---- fetch the document from Storage ----
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

    // ---- build the content block ----
    const b64 = buffer.toString('base64');
    let block;
    if (contentType === 'application/pdf' || /\.pdf$/i.test(fileName || '')) {
      block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    } else if (contentType.startsWith('image/')) {
      block = { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } };
    } else {
      throw new HttpsError('invalid-argument',
        `Unsupported file type "${contentType || 'unknown'}". Upload a PDF or an image.`);
    }

    // ---- call Claude ----
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
          max_tokens: 8000,
          system: SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [
              block,
              { type: 'text', text: 'Extract every scope line item from this document as JSON.' }
            ]
          }]
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

    // ---- parse, tolerating stray fences ----
    let parsed;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      parsed = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
    } catch (e) {
      console.error('parse failed. raw:', text.slice(0, 800));
      throw new HttpsError('internal', 'The AI response could not be read. Try again.');
    }

    const num = v => {
      if (v === null || v === undefined || v === '') return '';
      const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : '';
    };
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .map(it => ({
        description: String(it.description || '').trim(),
        qty: num(it.qty),
        unit: String(it.unit || '').trim(),
        rate: num(it.rate),
        section: String(it.section || '').trim()
      }))
      .filter(it => it.description);

    console.log(`extracted ${items.length} items from ${fileName || storagePath}`,
      'usage:', JSON.stringify(data.usage || {}));

    return { items, usage: data.usage || null };
  }
);
