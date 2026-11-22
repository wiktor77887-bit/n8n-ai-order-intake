// Uruchom: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOrder } = require('../src/validate.js');
const { normalizeInput } = require('../src/normalize.js');

const TODAY = '2026-11-20';
const input = { source: 'email', today: TODAY, sender_name: 'Jan Kowalski', sender_email: 'jan@firma.pl', subject: 'Zamówienie', received_at: '2026-11-20T10:00:00Z' };
const gemini = (obj) => ({ candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] });
const good = {
  is_order: true, language: 'pl', customer: 'ElektroMax', email: 'zakupy@elektromax.pl',
  items: [{ product: 'Kabel YDY 3x2,5 (100 m)', quantity: 4 }], delivery_date: '2026-12-01', notes: null, missing_fields: [],
};

test('poprawne zamówienie -> ok', () => {
  const r = validateOrder(input, gemini(good));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.issues, []);
  assert.equal(r.reply_subject, 'Potwierdzenie zamówienia');
});

test('brak ilości -> needs_review z nazwą produktu w mailu', () => {
  const r = validateOrder(input, gemini({ ...good, items: [{ product: 'Gniazdo 230V', quantity: null }], missing_fields: ['items[0].quantity'] }));
  assert.equal(r.status, 'needs_review');
  assert.deepEqual(r.missing_fields, ['items[0].quantity']);
  assert.match(r.reply_body, /Gniazdo 230V/);
});

test('ilość ujemna lub ułamkowa -> needs_review', () => {
  assert.equal(validateOrder(input, gemini({ ...good, items: [{ product: 'X', quantity: -2 }] })).status, 'needs_review');
  assert.equal(validateOrder(input, gemini({ ...good, items: [{ product: 'X', quantity: 1.5 }] })).status, 'needs_review');
});

test('data w przeszłości i niepoprawna data', () => {
  assert.deepEqual(validateOrder(input, gemini({ ...good, delivery_date: '2026-11-19' })).issues, ['delivery_date_in_past']);
  assert.deepEqual(validateOrder(input, gemini({ ...good, delivery_date: '2026-02-30' })).issues, ['delivery_date_invalid']);
  assert.equal(validateOrder(input, gemini({ ...good, delivery_date: TODAY })).status, 'ok');
});

test('brak daty -> missing delivery_date', () => {
  const r = validateOrder(input, gemini({ ...good, delivery_date: null, missing_fields: ['delivery_date'] }));
  assert.deepEqual(r.missing_fields, ['delivery_date']);
});

test('zły e-mail w treści -> email_invalid_format', () => {
  assert.deepEqual(validateOrder(input, gemini({ ...good, email: 'zakupy@elektromax' })).issues, ['email_invalid_format']);
});

test('brak e-maila w treści -> bierze adres nadawcy', () => {
  const r = validateOrder(input, gemini({ ...good, email: null, missing_fields: ['email'] }));
  assert.equal(r.status, 'ok');
  assert.equal(r.order.email, 'jan@firma.pl');
});

test('webhook bez e-maila i bez nazwy -> needs_review', () => {
  const r = validateOrder({ ...input, source: 'webhook', sender_email: '', sender_name: '' }, gemini({ ...good, email: null, customer: null }));
  assert.deepEqual(r.missing_fields.sort(), ['customer', 'email']);
  assert.equal(r.reply_to, null);
});

test('nie odpowiadamy na adresy no-reply', () => {
  const r = validateOrder({ ...input, sender_email: 'no-reply@google.com' }, gemini({ ...good, email: null }));
  assert.equal(r.reply_to, null);
  const r2 = validateOrder({ ...input, sender_email: 'no-reply@google.com' }, gemini(good));
  assert.equal(r2.reply_to, 'zakupy@elektromax.pl');
});

test('to nie jest zamówienie', () => {
  const r = validateOrder(input, gemini({ ...good, is_order: false, items: [] }));
  assert.equal(r.status, 'needs_review');
  assert.deepEqual(r.issues, ['not_an_order']);
  assert.match(r.reply_body, /nie wygląda ona na zamówienie/i);
});

test('LLM zwraca śmieci zamiast JSON -> needs_review, bez wyjątku', () => {
  for (const bad of ['to nie jest json', '{"is_order": tru', '[]', '']) {
    const r = validateOrder(input, gemini(bad));
    assert.equal(r.status, 'needs_review');
  }
  assert.deepEqual(validateOrder(input, gemini('nie json')).issues, ['llm_invalid_json']);
});

test('JSON w bloku ```json``` też przechodzi', () => {
  assert.equal(validateOrder(input, gemini('```json\n' + JSON.stringify(good) + '\n```')).status, 'ok');
});

test('błąd HTTP / pusta odpowiedź LLM -> needs_review', () => {
  assert.deepEqual(validateOrder(input, { error: { message: '503' } }).issues, ['llm_request_failed']);
  assert.deepEqual(validateOrder(input, { candidates: [] }).issues, ['llm_empty_response']);
  assert.deepEqual(validateOrder(input, undefined).issues, ['llm_empty_response']);
});

test('odpowiedź po angielsku dla angielskiego maila', () => {
  assert.equal(validateOrder(input, gemini({ ...good, language: 'en' })).reply_subject, 'Order confirmation');
});

test('normalizacja: mail z IMAP i webhook', () => {
  const e = normalizeInput({ from: 'Jan Kowalski <jan@firma.pl>', subject: 'Zam', textPlain: 'treść' }, TODAY);
  assert.equal(e.source, 'email');
  assert.equal(e.sender_email, 'jan@firma.pl');
  assert.equal(e.sender_name, 'Jan Kowalski');
  assert.equal(e.gemini_request.generationConfig.responseMimeType, 'application/json');

  const w = normalizeInput({ headers: {}, body: { email: 'a@b.pl', text: 'treść', dry_run: true } }, TODAY);
  assert.equal(w.source, 'webhook');
  assert.equal(w.dry_run, true);
  assert.match(w.gemini_request.contents[0].parts[0].text, /Today is 2026-11-20/);
});
