// Ewaluacja: wysyła wszystkie maile z samples/ na webhook i porównuje wynik z samples/expected.json.
// Uruchom (workflow musi być aktywny w n8n):
//   node scripts/run-eval.js
//   WEBHOOK_URL=http://localhost:5678/webhook-test/order node scripts/run-eval.js   (tryb testowy w edytorze)
// Domyślnie dry_run=true: zamówienia trafiają do arkusza, ale maile do klientów NIE są wysyłane.
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
  if (res.status !== exp.status) problems.push(`status ${res.status} (oczekiwano ${exp.status})`);
  if (exp.items !== undefined && (res.order?.items?.length ?? 0) !== exp.items) problems.push(`pozycji ${res.order?.items?.length ?? 0} (oczekiwano ${exp.items})`);
  if (exp.missing && !res.missing_fields?.includes(exp.missing)) problems.push(`brak "${exp.missing}" w missing_fields`);
  if (exp.issue && !res.issues?.includes(exp.issue)) problems.push(`brak "${exp.issue}" w issues`);
  if (exp.email && res.order?.email !== exp.email) problems.push(`email ${res.order?.email} (oczekiwano ${exp.email})`);
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
      problems = [`błąd wywołania: ${e.message}`];
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
    `Wynik: **${passed}/${rows.length}** przypadków zgodnych z oczekiwaniami (${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' })}).`,
    '',
    '| Mail | Oczekiwany status | Otrzymany status | Pozycji | Braki / problemy | Wynik |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.file} | ${r.expected} | ${r.got} | ${r.items} | ${r.details} | ${r.pass ? '✅' : '❌ ' + r.problems.join('; ')} |`),
    '',
  ].join('\n');

  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'results', 'eval-results.md'), md);
  fs.writeFileSync(path.join(root, 'results', 'eval-results.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(`\n${passed}/${rows.length} PASS. Tabela zapisana w results/eval-results.md (wklej ją do README).`);
  process.exit(passed === rows.length ? 0 : 1);
})();
