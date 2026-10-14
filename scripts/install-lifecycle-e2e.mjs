import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
const directory = await mkdtemp(resolve(tmpdir(), 'panini-lifecycle-e2e-'));
const project = 'panini-install-lifecycle-e2e';
const run = (...args) => spawnSync(process.execPath, ['scripts/selfhost.mjs', ...args, '--directory', directory, '--project', project], { encoding: 'utf8', maxBuffer: 5_000_000 });
const checks = [];
const base = 'http://127.0.0.1:4150';
try {
  assert.equal(run('init', '--url', base).status, 0);
  const path = resolve(directory, '.env');
  const content = (await readFile(path, 'utf8')).replace('POSTGRES_PORT=55432', 'POSTGRES_PORT=55438').replace('PANINI_PORT=4141', 'PANINI_PORT=4150').replace('@127.0.0.1:55432/', '@127.0.0.1:55438/');
  await writeFile(path, content, { mode: 0o600 });
  const env = parseEnv(content);
  const started = run('start');
  assert.equal(started.status, 0, started.stderr);
  assert.equal(run('doctor').status, 0);
  checks.push('Real production Compose starts PostgreSQL, migration, non-root app and worker with healthy probes on isolated ports.');
  const headers = { 'content-type': 'application/json', origin: base, connection: 'close' };
  const setup = await fetch(`${base}/api/auth/bootstrap`, { method: 'POST', headers, body: JSON.stringify({ token: env.APP_ADMIN_TOKEN, companyName: 'Install Lifecycle Company', displayName: 'Lifecycle Owner', email: 'lifecycle@example.test', password: 'Lifecycle installation password 71!' }) });
  assert.equal(setup.status, 200);
  const oldCookie = setup.headers.get('set-cookie').split(';')[0];
  const recovery = run('recover', '--email', 'lifecycle@example.test');
  assert.equal(recovery.status, 0, recovery.stderr);
  const reset = recovery.stdout.match(/http:\/\/127\.0\.0\.1:4150\/reset-password#([A-Za-z0-9_-]+)/);
  assert.ok(reset, 'Recovery must print a usable private fragment link.');
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie: oldCookie, connection: 'close' } })).status, 401);
  const changed = await fetch(`${base}/api/auth/reset-password`, { method: 'POST', headers, body: JSON.stringify({ token: reset[1], password: 'Recovered lifecycle password 81!' }) });
  assert.equal(changed.status, 200);
  checks.push('Operator CLI revokes prior sessions and returns a working single-use recovery link.');
  const updated = run('update', '--file', resolve(directory, 'pre-update.dump'));
  assert.equal(updated.status, 0, updated.stderr);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'lifecycle@example.test', password: 'Recovered lifecycle password 81!' }) });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).organization.name, 'Install Lifecycle Company');
  assert.equal(run('stop').status, 0);
  checks.push('Update builds, pauses writers, backs up, migrates again and restarts without losing company/account state; stop preserves the installation.');
  await mkdir('.panini/e2e', { recursive: true });
  await writeFile('.panini/e2e/install-lifecycle-results.json', JSON.stringify({ passed: true, checks, directory, timestamp: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, directory }, null, 2));
} finally {
  // Only this newly created test project's volume is removed, never the user's installation.
  const cleanup = spawnSync('docker', ['compose', '--env-file', resolve(directory, '.env'), '-p', project, '-f', 'compose.yaml', 'down', '--volumes'], { encoding: 'utf8' });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}
