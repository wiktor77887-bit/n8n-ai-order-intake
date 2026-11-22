// Normalizacja wejścia: mail z IMAP albo JSON z webhooka -> jeden wspólny format.
// Ten plik jest źródłem kodu węzła "Normalize input" (scripts/build-workflow.mjs wkleja go do workflow.json).

const GEMINI_MODEL = 'gemini-flash-latest'; // możesz przypiąć konkretną wersję, np. 'gemini-2.5-flash'
const MAX_TEXT_CHARS = 8000;

const ORDER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_order: { type: 'BOOLEAN', description: 'true if the message is a purchase order, false otherwise' },
    language: { type: 'STRING', description: 'language of the message: "pl" or "en"' },
    customer: { type: 'STRING', nullable: true, description: 'company or person placing the order' },
    email: { type: 'STRING', nullable: true, description: 'contact e-mail written in the message body, if any' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          product: { type: 'STRING' },
          quantity: { type: 'INTEGER', nullable: true, description: 'null if the quantity is not stated' },
        },
        required: ['product', 'quantity'],
      },
    },
    delivery_date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD, null if not stated' },
    notes: { type: 'STRING', nullable: true },
    missing_fields: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['is_order', 'language', 'customer', 'email', 'items', 'delivery_date', 'notes', 'missing_fields'],
};

function parseFrom(from) {
  // "Jan Kowalski <jan@firma.pl>" | "jan@firma.pl" | {value:[{address,name}]}
  if (from && typeof from === 'object' && Array.isArray(from.value) && from.value[0]) {
    return { email: from.value[0].address || '', name: from.value[0].name || '' };
  }
  const s = String(from || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: s };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function buildPrompt(subject, text, today) {
  return [
    'You extract purchase orders from customer e-mails for a B2B wholesaler.',
    `Today is ${today} (Europe/Warsaw). Resolve relative dates ("next Friday", "jutro", "za tydzień") to YYYY-MM-DD.`,
    'Rules:',
    '- Use only information present in the message. Never invent products, quantities, dates or e-mails.',
    '- If a value is not stated, return null and add the field name to missing_fields',
    '  (use "customer", "email", "delivery_date", "items", or "items[N].quantity" with 0-based N).',
    '- Fix obvious typos in product names, keep the product description otherwise as written.',
    '- quantity must be a whole number of units/packs as written by the customer.',
    '- If the message is a question or anything other than an order, set is_order=false and items=[].',
    '- language: "pl" for Polish, "en" for English.',
    '',
    `Subject: ${subject}`,
    'Message:',
    '"""',
    text,
    '"""',
  ].join('\n');
}

function normalizeInput(raw, today) {
  let source, sender, subject, text, dryRun = false;

  if (raw && raw.body && typeof raw.body === 'object' && raw.headers) {
    // Webhook: { headers, params, query, body: { name, email, subject, text, dry_run } }
    const b = raw.body;
    source = 'webhook';
    sender = { name: String(b.name || '').trim(), email: String(b.email || '').trim() };
    subject = String(b.subject || '');
    text = String(b.text || b.message || '');
    dryRun = b.dry_run === true;
  } else {
    // Email Trigger (IMAP), format "simple"
    source = 'email';
    sender = parseFrom(raw.from);
    subject = String(raw.subject || '');
    text = String(raw.textPlain || raw.text || '') || stripHtml(raw.textHtml || raw.html);
  }

  text = text.slice(0, MAX_TEXT_CHARS);

  return {
    source,
    dry_run: dryRun,
    received_at: new Date().toISOString(),
    today,
    sender_name: sender.name,
    sender_email: sender.email,
    subject,
    text,
    model: GEMINI_MODEL,
    gemini_request: {
      contents: [{ role: 'user', parts: [{ text: buildPrompt(subject, text, today) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: ORDER_SCHEMA,
      },
    },
  };
}

if (typeof module !== 'undefined') module.exports = { normalizeInput, parseFrom, stripHtml, ORDER_SCHEMA };
