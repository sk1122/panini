#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'panini-package-e2e-'));
const releaseDirectory = resolve(root, 'artifacts', 'package-cli');
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(temporary, 'npm-cache') }, ...options });
  assert.equal(result.status, 0, `${program} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

run('pnpm', ['run', 'build']);
run(process.execPath, ['scripts/prepare-package.mjs']);
await mkdir(releaseDirectory, { recursive: true });
const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', releaseDirectory]));
const archive = resolve(releaseDirectory, packed[0].filename);
const names = new Set(packed[0].files.map(file => file.path));
for (const path of [
  'scripts/panini.mjs', 'scripts/selfhost.mjs', 'compose.yaml', 'compose.https.yaml',
  'Dockerfile', 'package.json', 'package-assets/pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'src/main.ts', 'dist/src/main.js',
  'config/panini.selfhost.yaml', 'public/panini-mark.svg',
  'drizzle/meta/_journal.json', 'integrations/slack/manifest.yaml',
]) assert.ok(names.has(path), `Release is missing ${path}`);
assert.ok(![...names].some(path => path === '.env' || path.startsWith('node_modules/') || path.endsWith('.local.yaml')), 'Release contains a local secret or dependency folder.');

run('tar', ['-xzf', archive, '-C', temporary]);
const packageRoot = join(temporary, 'package');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(manifest.bin.panini, 'scripts/panini.mjs');
assert.equal(run(process.execPath, [join(packageRoot, 'scripts', 'panini.mjs'), '--version']).trim(), manifest.version);

const installation = join(temporary, 'installation');
await mkdir(installation);
const cli = [join(packageRoot, 'scripts', 'panini.mjs')];
run(process.execPath, [...cli, 'init', '--url', 'http://127.0.0.1:4141'], { cwd: installation });
const environment = resolve(installation, '.env');
const configured = await readFile(environment, 'utf8');
assert.match(configured, /POSTGRES_PASSWORD=/);
assert.match(configured, /CONTENT_ENCRYPTION_KEY=/);
assert.match(configured, /PANINI_PUBLIC_URL=http:\/\/127\.0\.0\.1:4141/);
const stagedRelease = join(installation, '.panini', 'releases', manifest.version);
assert.equal(await readFile(join(stagedRelease, 'pnpm-lock.yaml'), 'utf8'), await readFile(join(packageRoot, 'package-assets', 'pnpm-lock.yaml'), 'utf8'));
run('docker', ['compose', '--env-file', environment, '-f', join(stagedRelease, 'compose.yaml'), '-p', 'panini', 'config', '--quiet'], { cwd: installation });

const fakeBin = join(temporary, 'bin');
const dockerLog = join(temporary, 'docker-args.txt');
await mkdir(fakeBin);
const docker = join(fakeBin, 'docker');
await writeFile(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PANINI_PACKAGE_E2E_DOCKER_LOG"\n');
await chmod(docker, 0o700);
run(process.execPath, [...cli, 'doctor'], {
  cwd: installation,
  env: { ...process.env, PATH: fakeBin + ':' + process.env.PATH, PANINI_PACKAGE_E2E_DOCKER_LOG: dockerLog },
});
const dockerCalls = await readFile(dockerLog, 'utf8');
assert.match(dockerCalls, /-p panini/);
assert.match(dockerCalls, /compose\.yaml/);
assert.match(dockerCalls, /config --quiet/);

const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const report = {
  passed: true,
  package: manifest.name + '@' + manifest.version,
  archive,
  sha256,
  checks: [
    'Publishable archive includes the CLI, server build, Compose files, migrations, and assets.',
    'Archive excludes private environment files and local configuration.',
    'Extracted CLI reports its version, initializes persistent configuration, and invokes Compose with a stable project name.',
    'Staged release restores the exact pnpm lockfile and passes real Docker Compose configuration validation.',
  ],
};
await writeFile(resolve(releaseDirectory, 'package-cli-e2e.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
