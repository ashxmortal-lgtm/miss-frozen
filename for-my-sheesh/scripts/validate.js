import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

function ok(label) {
  checks.push(label);
}

function fail(label, detail) {
  failures.push(detail ? `${label}: ${detail}` : label);
}

function walk(dir, predicate = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.tgcloud', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, predicate));
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/(\"(?:[^\"\\]|\\.)*\")|,(\s*[}\]])/g, (match, stringValue, close) =>
    stringValue === undefined ? close : stringValue,
  );
}

// 1. Syntax of every JavaScript file.
const files = walk(ROOT, (file) => file.endsWith('.js'));
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    fail('syntax', `${path.relative(ROOT, file)}\n${error.stderr?.toString() ?? ''}`);
  }
}
ok(`syntax: ${files.length} JavaScript files`);

// 2. Import rules for deployed modules and the browser app.
const SERVER_BARE = new Set(['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch', 'sdk/console']);
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  const inServer = rel.startsWith('tgcloud/');
  const inWeb = rel.startsWith('web/');
  if (!inServer && !inWeb) continue;

  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);

  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      if (!specifier.endsWith('.js')) {
        fail('imports', `${rel} imports "${specifier}" without a .js extension`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(resolved)) {
        fail('imports', `${rel} imports missing file "${specifier}"`);
      }
      if (inServer && !resolved.startsWith(path.join(ROOT, 'tgcloud') + path.sep)) {
        fail('imports', `${rel} reaches outside tgcloud/: "${specifier}"`);
      }
    } else if (inServer && !SERVER_BARE.has(specifier)) {
      fail('imports', `${rel} imports unsupported module "${specifier}"`);
    } else if (inWeb) {
      fail('imports', `${rel} imports a bare package "${specifier}" (frontend must be dependency-free)`);
    }
  }

  if (inServer && /from\s+['"]node:/.test(source)) {
    fail('imports', `${rel} uses a Node built-in that the isolate does not provide`);
  }
  if (inWeb) {
    if (/initDataUnsafe/.test(source)) fail('frontend', `${rel} references initDataUnsafe`);
    if (/\binnerHTML\b/.test(source)) fail('frontend', `${rel} uses innerHTML`);
    if (/process\.env/.test(source)) fail('frontend', `${rel} reads process.env`);
    if (/\bfetch\s*\(/.test(source)) fail('frontend', `${rel} hand-rolls fetch instead of Serverless.call`);
  }
}
ok('imports: only sdk/project modules server-side, relative .js modules in the browser');

// 3. Handler/endpoint layout and guards.
const handlers = fs.readdirSync(path.join(ROOT, 'tgcloud/handlers'));
for (const name of handlers) {
  if (!/^[a-z_]+\.js$/.test(name)) fail('layout', `unexpected handler file "${name}"`);
}
for (const required of ['message.js', 'callback_query.js']) {
  if (!handlers.includes(required)) fail('layout', `missing handler ${required}`);
}
const endpoints = fs.readdirSync(path.join(ROOT, 'tgcloud/endpoints'));
for (const name of endpoints) {
  if (!/^[A-Za-z][A-Za-z0-9_]*\.js$/.test(name)) fail('layout', `unexpected endpoint "${name}"`);
  const source = read(`tgcloud/endpoints/${name}`);
  if (!source.includes('api_service.js')) fail('endpoints', `${name} does not use the shared guard`);
  if (!source.includes('toEndpointError')) fail('endpoints', `${name} does not sanitize errors`);
}
if (endpoints.length === 0) fail('endpoints', 'no Mini App endpoints found');
ok(`layout: ${handlers.length} handlers, ${endpoints.length} guarded endpoints`);

// 4. Schema + SQL.
const schema = read('tgcloud/schema.js');
for (const table of [
  'access_list',
  'owner_audit',
  'bot_settings',
  'processed_updates',
  'menu_taps',
]) {
  if (!schema.includes(`'${table}'`)) fail('schema', `table ${table} is not declared`);
}
if (/\.references\s*\(|foreignKey\s*\(/.test(schema)) {
  fail('schema', 'foreign keys are not supported by the TGCloud runtime');
}
const sql = read('tgcloud/lib/sql.js');
if (!sql.includes('access_list')) fail('schema', 'allowlist SQL missing');
if (!sql.includes('ON CONFLICT(telegram_id) DO NOTHING')) fail('schema', 'grant is not atomic');
ok('schema: durable allowlist, settings, update dedupe; no foreign keys');

// 5. Project configuration.
let config;
try {
  config = JSON.parse(stripJsonc(read('tgcloud.jsonc')));
} catch (error) {
  fail('config', `tgcloud.jsonc is not valid JSONC (${error.message})`);
}
if (config) {
  const staticConfig = config.static;
  if (!staticConfig || typeof staticConfig !== 'object') {
    fail('config', 'static block is missing');
  } else {
    if (staticConfig.source !== 'web') fail('config', 'static.source must be "web"');
    if (staticConfig.spa !== true) fail('config', 'static.spa must be true for /gift deep links');
    const headerText = JSON.stringify(staticConfig.headers ?? []);
    if (/X-Frame-Options|frame-ancestors/i.test(headerText)) {
      fail('config', 'do not block Telegram Web from iframing the Mini App');
    }
  }
  if (!fs.existsSync(path.join(ROOT, 'web/index.html'))) fail('config', 'web/index.html missing');
  if (!fs.existsSync(path.join(ROOT, 'web/css/app.css'))) fail('config', 'web/css/app.css missing');
  if (!fs.existsSync(path.join(ROOT, 'web/js/app.js'))) fail('config', 'web/js/app.js missing');
}
ok('config: TGCloud static hosting with SPA gift route');

// 6. Trusted config + content invariants.
const serverConfig = await import('../tgcloud/lib/config.js');
const content = await import('../tgcloud/lib/content.js');
if (serverConfig.OWNER_TELEGRAM_ID !== 8716863150) {
  fail('config', `OWNER_TELEGRAM_ID is ${serverConfig.OWNER_TELEGRAM_ID}, expected 8716863150`);
}
if (serverConfig.OWNER_TELEGRAM_ID !== 8716863150 || !Number.isSafeInteger(serverConfig.OWNER_TELEGRAM_ID)) {
  fail('config', 'owner ID must be the trusted numeric constant');
}
if (serverConfig.BUTTON_LABELS.menu !== 'mini 🎁 surprises') fail('content', 'primary button label changed');
if (serverConfig.BUTTON_LABELS.date !== '8 oct 2026') fail('content', 'date button label changed');
if (serverConfig.BUTTON_LABELS.gift !== 'hehe 🤌') fail('content', 'gift button label changed');
for (const [name, data] of Object.entries(serverConfig.CALLBACKS)) {
  if (Buffer.byteLength(data, 'utf8') > 64) fail('content', `callback ${name} exceeds 64 bytes`);
}
if (!content.UNAUTHORIZED_TEMPLATE.includes('{mention}')) fail('content', 'mention placeholder missing');
if (content.LETTER.paragraphs.length !== 12) fail('content', 'letter paragraph count changed');
if (!content.LETTER.signature.includes('With love')) fail('content', 'letter signature missing');
if (serverConfig.GIFT_ROUTE !== '/gift') fail('config', 'gift route changed');
ok('content: owner 8716863150, exact labels, 12 paragraphs + signature');

// 7. Private content must not exist in static files.
const webFiles = walk(path.join(ROOT, 'web'), (file) => file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css'));
const privateNeedles = [content.LETTER.paragraphs[0], content.LETTER.signature, String(serverConfig.OWNER_TELEGRAM_ID)];
for (const file of webFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const needle of privateNeedles) {
    if (source.includes(needle)) {
      fail('privacy', `${path.relative(ROOT, file)} contains private content`);
    }
  }
}
if (!read('web/index.html').includes('Open Your Gift 🎁')) fail('frontend', 'gift button copy missing');
if (!read('web/index.html').includes('Hi Sheesh\'s Mommy! 👋')) fail('frontend', 'greeting copy missing');
ok('privacy: no letter, signature or owner ID in public static assets');

// 8. Secret scan.
const secretPatterns = [
  [/\b[0-9]{6,10}:[A-Za-z0-9_-]{30,}\b/, 'Telegram bot token'],
  [/\bapp[0-9]{6,}:[A-Za-z0-9_-]{20,}\b/, 'TGCloud CLI token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
];
const scanFiles = walk(ROOT, (file) => {
  const rel = path.relative(ROOT, file);
  return !rel.endsWith('package-lock.json') && !rel.startsWith('test/') && !rel.startsWith('docs/');
});
for (const file of scanFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of secretPatterns) {
    if (pattern.test(source)) fail('secrets', `${label} found in ${path.relative(ROOT, file)}`);
  }
}
if (fs.existsSync(path.join(ROOT, '.env'))) fail('secrets', '.env must never be committed');
for (const required of ['.env.example', '.gitignore', 'README.md', 'AGENTS.md']) {
  if (!fs.existsSync(path.join(ROOT, required))) fail('files', `${required} is missing`);
}
if (!fs.existsSync(path.join(ROOT, 'package-lock.json'))) fail('files', 'package-lock.json is missing');
ok('secrets: no bot/CLI tokens, private keys or .env files');

// 9. Important files are deployable/tracked.
for (const rel of ['tgcloud.jsonc', 'tgcloud/schema.js', 'web/index.html', 'web/js/app.js']) {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT, stdio: 'pipe' });
    fail('git', `${rel} is ignored by .gitignore`);
  } catch {
    // exit code 1 means "not ignored", which is what we want.
  }
}
if (process.env.CI) {
  for (const rel of [
    'tgcloud.jsonc',
    'tgcloud/schema.js',
    'tgcloud/handlers/message.js',
    'web/index.html',
    'web/js/app.js',
  ]) {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, stdio: 'pipe' });
    } catch {
      fail('git', `${rel} is not tracked by Git`);
    }
  }
}
ok('git: TGCloud config and Mini App files are deployable (tracked check enforced in CI)');

// 10. Build artifact surface.
const staticRequested = fs
  .readFileSync(path.join(ROOT, 'web/index.html'), 'utf8')
  .match(/(?:href|src)="(\/[^"]+)"/g) ?? [];
for (const match of staticRequested) {
  const asset = match.replace(/^[^"]+"/, '').replace(/"$/, '');
  if (asset.startsWith('//')) continue;
  if (!fs.existsSync(path.join(ROOT, 'web', asset.replace(/^\//, '')))) {
    fail('static', `referenced asset ${asset} does not exist`);
  }
}
ok('static: referenced local HTML/CSS/JS assets exist');

// Report.
console.log('For My Sheesh — pre-deployment validation\n');
for (const check of checks) console.log(`✓ ${check}`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} validation failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nAll local validation checks passed.');
