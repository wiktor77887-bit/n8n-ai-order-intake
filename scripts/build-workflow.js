// Składa workflow.json z plików w src/, żeby kod w węzłach Code był tym samym kodem, który testujesz.
// Uruchom: node scripts/build-workflow.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const src = (f) =>
  fs.readFileSync(path.join(root, 'src', f), 'utf8').replace(/^if \(typeof module !== 'undefined'\).*$/m, '').trimEnd();

const uuid = (name) => {
  const h = crypto.createHash('sha1').update('n8n-ai-order-intake:' + name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const MAILBOX = 'TWOJA.SKRZYNKA.TESTOWA@gmail.com'; // zmień w węzłach Send Email po imporcie

const normalizeCode = `${src('normalize.js')}

// --- n8n ---
const today = $now.setZone('Europe/Warsaw').toFormat('yyyy-MM-dd');
return { json: normalizeInput($json, today) };
`;

const validateCode = `${src('validate.js')}

// --- n8n ---
// $json to odpowiedź z Gemini (albo obiekt { error } gdy HTTP Request się nie powiódł).
const input = $('Normalize input').item.json;
return { json: validateOrder(input, $json) };
`;

const cond = (id, leftValue, operator, rightValue = '') => ({ id: uuid(id), leftValue, rightValue, operator });
const ifParams = (conditions) => ({
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions, combinator: 'and' },
  options: {},
});
const assign = (name, value) => ({ id: uuid('set-' + name), name, value, type: 'string' });

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, id: uuid(name), name, type, typeVersion, position, ...extra,
});

const nodes = [
  node('Email Trigger (IMAP)', 'n8n-nodes-base.emailReadImap', 2, [0, 0], {
    postProcessAction: 'read',
    format: 'simple',
    options: { customEmailConfig: '["UNSEEN"]' },
  }),
  node('Webhook POST /order', 'n8n-nodes-base.webhook', 2, [0, 220], {
    httpMethod: 'POST', path: 'order', responseMode: 'responseNode', options: {},
  }, { webhookId: uuid('webhook-order') }),
  node('Normalize input', 'n8n-nodes-base.code', 2, [260, 110], { mode: 'runOnceForEachItem', jsCode: normalizeCode }),
  node('Gemini: extract order', 'n8n-nodes-base.httpRequest', 4.2, [520, 110], {
    method: 'POST',
    url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.model }}:generateContent',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.gemini_request) }}',
    options: { timeout: 60000 },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput' }),
  node('Validate order', 'n8n-nodes-base.code', 2, [780, 110], { mode: 'runOnceForEachItem', jsCode: validateCode }),

  node('Sheet row', 'n8n-nodes-base.set', 3.4, [1040, -120], {
    mode: 'manual',
    assignments: { assignments: [
      assign('received_at', '={{ $json.received_at }}'),
      assign('source', '={{ $json.source }}'),
      assign('status', '={{ $json.status }}'),
      assign('customer', '={{ $json.order.customer }}'),
      assign('email', '={{ $json.order.email }}'),
      assign('items', "={{ $json.order.items.map(i => i.product + ' x ' + (i.quantity ?? '?')).join('; ') }}"),
      assign('delivery_date', '={{ $json.order.delivery_date }}'),
      assign('notes', '={{ $json.order.notes }}'),
      assign('missing_fields', "={{ $json.missing_fields.join(', ') }}"),
      assign('issues', "={{ $json.issues.join(', ') }}"),
      assign('subject', '={{ $json.subject }}'),
    ] },
    includeOtherFields: false,
    options: {},
  }),
  node('Google Sheets: append', 'n8n-nodes-base.googleSheets', 4.5, [1300, -120], {
    operation: 'append',
    documentId: { __rl: true, value: '', mode: 'url' },
    sheetName: { __rl: true, value: '', mode: 'list' },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  }),

  node('Send reply?', 'n8n-nodes-base.if', 2, [1040, 110], ifParams([
    cond('c-reply-to', '={{ $json.reply_to }}', { type: 'string', operation: 'notEmpty', singleValue: true }),
    cond('c-dry-run', '={{ $json.dry_run }}', { type: 'boolean', operation: 'false', singleValue: true }),
  ])),
  node('Status = ok?', 'n8n-nodes-base.if', 2, [1300, 110], ifParams([
    cond('c-status', '={{ $json.status }}', { type: 'string', operation: 'equals' }, 'ok'),
  ])),
  ...[['Email: confirmation', [1560, 20]], ['Email: ask for missing data', [1560, 200]]].map(([name, pos]) =>
    node(name, 'n8n-nodes-base.emailSend', 2.1, pos, {
      fromEmail: MAILBOX,
      toEmail: '={{ $json.reply_to }}',
      subject: '={{ $json.reply_subject }}',
      emailFormat: 'text',
      text: '={{ $json.reply_body }}',
      options: { appendAttribution: false },
    }, { onError: 'continueRegularOutput' })),

  node('From webhook?', 'n8n-nodes-base.if', 2, [1040, 340], ifParams([
    cond('c-source', '={{ $json.source }}', { type: 'string', operation: 'equals' }, 'webhook'),
  ])),
  node('Respond to Webhook', 'n8n-nodes-base.respondToWebhook', 1.1, [1300, 340], {
    respondWith: 'json', responseBody: '={{ JSON.stringify($json.api_response) }}', options: {},
  }),

  node('Note', 'n8n-nodes-base.stickyNote', 1, [-40, -260], {
    content: '## AI Order Intake\nMail albo POST /order → Gemini wyciąga dane do JSON → JavaScript sprawdza poprawność → arkusz + odpowiedź do klienta.\n\nStatus **ok** = potwierdzenie, **needs_review** = prośba o brakujące dane.',
    height: 200, width: 520,
  }),
];

const link = (to, index = 0) => ({ node: to, type: 'main', index });
const connections = {
  'Email Trigger (IMAP)': { main: [[link('Normalize input')]] },
  'Webhook POST /order': { main: [[link('Normalize input')]] },
  'Normalize input': { main: [[link('Gemini: extract order')]] },
  'Gemini: extract order': { main: [[link('Validate order')]] },
  'Validate order': { main: [[link('Sheet row'), link('Send reply?'), link('From webhook?')]] },
  'Sheet row': { main: [[link('Google Sheets: append')]] },
  'Send reply?': { main: [[link('Status = ok?')], []] },
  'Status = ok?': { main: [[link('Email: confirmation')], [link('Email: ask for missing data')]] },
  'From webhook?': { main: [[link('Respond to Webhook')], []] },
};

const workflow = {
  name: 'AI Order Intake',
  nodes,
  connections,
  active: false,
  settings: { executionOrder: 'v1', timezone: 'Europe/Warsaw' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

fs.writeFileSync(path.join(root, 'workflow.json'), JSON.stringify(workflow, null, 2) + '\n');
console.log(`workflow.json: ${nodes.length} nodes`);
