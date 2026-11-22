// Parsowanie odpowiedzi LLM i walidacja zamówienia.
// Ten plik jest źródłem kodu węzła "Validate order" (scripts/build-workflow.mjs wkleja go do workflow.json).
// Zasada: niezależnie od tego, co zwróci LLM, ta funkcja nigdy nie rzuca wyjątku.
// W najgorszym razie zwraca status "needs_review".

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Adresy automatyczne: na nie nie odpowiadamy (unikamy pętli i maili do no-reply).
const NO_REPLY_RE = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@)/i;

function extractLlmText(llm) {
  if (!llm || typeof llm !== 'object') return { error: 'llm_empty_response' };
  if (llm.error) return { error: 'llm_request_failed' };
  const parts = llm.candidates && llm.candidates[0] && llm.candidates[0].content && llm.candidates[0].content.parts;
  if (!Array.isArray(parts)) return { error: 'llm_empty_response' };
  const text = parts.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  return text.trim() ? { text } : { error: 'llm_empty_response' };
}

function parseLlmJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(cleaned);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? { obj } : { error: 'llm_invalid_json' };
  } catch (e) {
    return { error: 'llm_invalid_json' };
  }
}

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function validateOrder(input, llmResponse) {
  const issues = [];
  const missing = new Set();

  let data = {};
  const extracted = extractLlmText(llmResponse);
  if (extracted.error) {
    issues.push(extracted.error);
  } else {
    const parsed = parseLlmJson(extracted.text);
    if (parsed.error) issues.push(parsed.error);
    else data = parsed.obj;
  }
  const llmOk = issues.length === 0;

  const language = data.language === 'en' ? 'en' : 'pl';
  const isOrder = llmOk ? data.is_order !== false : null;

  // Dane kontaktowe: z treści maila, a jeśli ich brak, to z nadawcy.
  const customer = str(data.customer) || str(input.sender_name);
  const email = str(data.email) || str(input.sender_email);

  // Pozycje zamówienia
  const items = [];
  if (Array.isArray(data.items)) {
    data.items.forEach((it, i) => {
      const product = it && str(it.product);
      const q = it ? it.quantity : null;
      if (!product) issues.push(`items[${i}].product_empty`);
      if (q === null || q === undefined || q === '') missing.add(`items[${i}].quantity`);
      else if (!Number.isInteger(q) || q <= 0) issues.push(`items[${i}].quantity_not_positive_integer`);
      items.push({ product: product || '', quantity: Number.isInteger(q) ? q : null });
    });
  } else if (llmOk) {
    issues.push('items_not_array');
  }

  if (llmOk && isOrder) {
    if (items.length === 0) missing.add('items');
    if (!customer) missing.add('customer');

    if (!email) missing.add('email');
    else if (!EMAIL_RE.test(email)) issues.push('email_invalid_format');

    const dd = data.delivery_date;
    if (dd === null || dd === undefined || dd === '') missing.add('delivery_date');
    else if (!isValidIsoDate(dd)) issues.push('delivery_date_invalid');
    else if (dd < input.today) issues.push('delivery_date_in_past');

    // Pola, które LLM sam oznaczył jako brakujące (o ile faktycznie ich nie uzupełniliśmy)
    if (Array.isArray(data.missing_fields)) {
      for (const f of data.missing_fields) {
        if (typeof f !== 'string') continue;
        if (f === 'customer' && customer) continue;
        if (f === 'email' && email) continue;
        if (f === 'delivery_date' && isValidIsoDate(dd)) continue;
        if (/^items\[\d+\]\.quantity$/.test(f)) {
          const idx = Number(f.match(/\d+/)[0]);
          if (items[idx] && items[idx].quantity) continue;
        }
        if (f === 'items' && items.length) continue;
        missing.add(f);
      }
    }
  }

  if (llmOk && isOrder === false) issues.push('not_an_order');

  const missingFields = [...missing];
  const status = llmOk && isOrder && issues.length === 0 && missingFields.length === 0 ? 'ok' : 'needs_review';

  const order = {
    customer,
    email,
    items,
    delivery_date: isValidIsoDate(data.delivery_date) ? data.delivery_date : null,
    notes: str(data.notes),
  };

  const reply = buildReply({ status, language, order, missingFields, issues, isOrder });

  return {
    status,
    issues,
    missing_fields: missingFields,
    is_order: isOrder,
    language,
    order,
    source: input.source,
    dry_run: input.dry_run === true,
    received_at: input.received_at,
    subject: input.subject,
    reply_to: [str(input.sender_email), EMAIL_RE.test(email || '') ? email : null].find((a) => a && !NO_REPLY_RE.test(a)) || null,
    reply_subject: reply.subject,
    reply_body: reply.body,
    api_response: { status, issues, missing_fields: missingFields, order },
  };
}

const FIELD_LABELS = {
  pl: { customer: 'nazwa firmy lub osoby zamawiającej', email: 'adres e-mail do kontaktu', delivery_date: 'data dostawy', items: 'lista produktów' },
  en: { customer: 'company or person placing the order', email: 'contact e-mail address', delivery_date: 'delivery date', items: 'list of products' },
};

function describeMissing(field, lang, items) {
  const m = field.match(/^items\[(\d+)\]\.quantity$/);
  if (m) {
    const p = items[Number(m[1])];
    const name = p && p.product ? `"${p.product}"` : `#${Number(m[1]) + 1}`;
    return lang === 'en' ? `quantity of ${name}` : `ilość dla pozycji ${name}`;
  }
  return FIELD_LABELS[lang][field] || field;
}

function describeIssue(issue, lang) {
  const pl = {
    delivery_date_in_past: 'podana data dostawy już minęła',
    delivery_date_invalid: 'data dostawy ma niepoprawny format',
    email_invalid_format: 'adres e-mail ma niepoprawny format',
  };
  const en = {
    delivery_date_in_past: 'the requested delivery date is in the past',
    delivery_date_invalid: 'the delivery date is not a valid date',
    email_invalid_format: 'the e-mail address is not valid',
  };
  if (/quantity_not_positive_integer/.test(issue)) return lang === 'en' ? 'one of the quantities is not a whole positive number' : 'jedna z ilości nie jest dodatnią liczbą całkowitą';
  return (lang === 'en' ? en : pl)[issue] || null;
}

function buildReply({ status, language: lang, order, missingFields, issues, isOrder }) {
  const lines = order.items.map((it) => `- ${it.product}: ${it.quantity ?? '?'}`).join('\n');

  if (status === 'ok') {
    return lang === 'en'
      ? { subject: 'Order confirmation', body: `Hello,\n\nthank you for your order. We have registered:\n${lines}\n\nRequested delivery date: ${order.delivery_date}\n\nBest regards,\nSales team` }
      : { subject: 'Potwierdzenie zamówienia', body: `Dzień dobry,\n\ndziękujemy za zamówienie. Zarejestrowaliśmy:\n${lines}\n\nTermin dostawy: ${order.delivery_date}\n\nPozdrawiamy,\nDział sprzedaży` };
  }

  if (isOrder === false) {
    return lang === 'en'
      ? { subject: 'We received your message', body: 'Hello,\n\nthank you for your message. It does not look like an order, so we have passed it on to our sales team, who will get back to you.\n\nBest regards,\nSales team' }
      : { subject: 'Otrzymaliśmy Twoją wiadomość', body: 'Dzień dobry,\n\ndziękujemy za wiadomość. Nie wygląda ona na zamówienie, dlatego przekazaliśmy ją do działu sprzedaży, który odpowie najszybciej, jak to możliwe.\n\nPozdrawiamy,\nDział sprzedaży' };
  }

  const problems = [
    ...missingFields.map((f) => describeMissing(f, lang, order.items)),
    ...issues.map((i) => describeIssue(i, lang)).filter(Boolean),
  ];

  if (problems.length === 0) {
    // Błąd techniczny po naszej stronie (np. LLM nie odpowiedział): nie obciążamy klienta.
    return lang === 'en'
      ? { subject: 'Your order is being processed', body: 'Hello,\n\nwe have received your order. A member of our team will review it and confirm shortly.\n\nBest regards,\nSales team' }
      : { subject: 'Zamówienie w trakcie weryfikacji', body: 'Dzień dobry,\n\notrzymaliśmy zamówienie. Nasz pracownik je sprawdzi i wkrótce potwierdzi.\n\nPozdrawiamy,\nDział sprzedaży' };
  }

  const list = problems.map((p) => `- ${p}`).join('\n');
  return lang === 'en'
    ? { subject: 'We need a few more details for your order', body: `Hello,\n\nthank you for your order. To process it, we need the following:\n${list}\n\nWhat we have so far:\n${lines || '- (no products recognised)'}\n\nPlease reply to this e-mail with the missing details.\n\nBest regards,\nSales team` }
    : { subject: 'Prosimy o uzupełnienie zamówienia', body: `Dzień dobry,\n\ndziękujemy za zamówienie. Żeby je zrealizować, potrzebujemy jeszcze:\n${list}\n\nTo, co już mamy:\n${lines || '- (nie rozpoznaliśmy produktów)'}\n\nProsimy o odpowiedź na tego maila z brakującymi danymi.\n\nPozdrawiamy,\nDział sprzedaży` };
}

if (typeof module !== 'undefined') module.exports = { validateOrder, extractLlmText, parseLlmJson, isValidIsoDate };
