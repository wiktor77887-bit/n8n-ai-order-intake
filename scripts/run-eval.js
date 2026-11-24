// Evaluation: sends every e-mail from samples/ to the webhook and compares the result with samples/expected.json.
// Run (the workflow must be published in n8n):
//   node scripts/run-eval.js
//   WEBHOOK_URL=http://localhost:5678/webhook-test/order node scripts/run-eval.js   (editor test mode)
// dry_run=true by default: orders are written to the sheet, but NO e-mails are sent to customers.
const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/order';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const root = path.join(__dirname, '..');
const samplesDir = path.join(root, 'samples');
const expected = JSON.parse(fs.readFileSync(path.join(samplesDir, 'expected.json'), 'utf8'));

function parseSample(raw) {
  const [head, ...rest] = raw.replace(/\r\n/g, '\n').split('\n\n');
  const headers = Object.fromEntries(
    head.split('\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
  );
  const m = (headers.from || '').match(/^(.*?)\s*<([^>]+)>$/);
  return { name: m ? m[1] : '', email: m ? m[2] : headers.from, subject: headers.subject || '', text: rest.join('\n\n').trim() };
}

function check(exp, res) {
  const problems = [];
  if (res.status !== exp.status) problems.push(`status ${res.status} (expected ${exp.status})`);
  if (exp.items !== undefined && (res.order?.items?.length ?? 0) !== exp.items) problems.push(`items ${res.order?.items?.length ?? 0} (expected ${exp.items})`);
  if (exp.missing && !res.missing_fields?.includes(exp.missing)) problems.push(`"${exp.missing}" not in missing_fields`);
  if (exp.issue && !res.issues?.includes(exp.issue)) problems.push(`"${exp.issue}" not in issues`);
  if (exp.email && res.order?.email !== exp.email) problems.push(`email ${res.order?.email} (expected ${exp.email})`);
  return problems;
}

(async () => {
  const rows = [];
  for (const file of Object.keys(expected)) {
    const sample = parseSample(fs.readFileSync(path.join(samplesDir, file), 'utf8'));
    const t0 = Date.now();
    let res, problems;
    try {
      const r = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sample, dry_run: DRY_RUN }),
      });
      res = await r.json();
      problems = check(expected[file], res);
    } catch (e) {
      res = {};
      problems = [`request failed: ${e.message}`];
    }
    const row = {
      file,
      expected: expected[file].status,
      got: res.status || '-',
      items: res.order?.items?.length ?? '-',
      details: [...(res.missing_fields || []), ...(res.issues || [])].join(', ') || '-',
      pass: problems.length === 0,
      problems,
      ms: Date.now() - t0,
    };
    rows.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${file}  ${row.got}  ${row.ms} ms  ${problems.join('; ')}`);
  }

  const passed = rows.filter((r) => r.pass).length;
  const md = [
    `Result: **${passed}/${rows.length}** cases matched expectations (${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })}).`,
    '',
    '| E-mail | Expected status | Actual status | Items | Missing / issues | Result |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.file} | ${r.expected} | ${r.got} | ${r.items} | ${r.details} | ${r.pass ? '✅' : '❌ ' + r.problems.join('; ')} |`),
    '',
  ].join('\n');

  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'results', 'eval-results.md'), md);
  fs.writeFileSync(path.join(root, 'results', 'eval-results.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(`\n${passed}/${rows.length} PASS. Table saved to results/eval-results.md (paste it into the README).`);
  process.exit(passed === rows.length ? 0 : 1);
})();
