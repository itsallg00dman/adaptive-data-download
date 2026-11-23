import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/download.mjs', import.meta.url));
const sha = contents => createHash('sha256').update(contents).digest('hex');

async function fixture(t, contents = Buffer.from('reproducible test payload\n'.repeat(128))) {
  const root = await mkdtemp(join(tmpdir(), 'adaptive-test-'));
  const output = join(root, 'downloads');
  const requests = [];
  const etag = `"${sha(contents)}"`;
  const server = createServer((req, res) => {
    if (req.method === 'GET') requests.push(req.headers.range ?? 'full');
    if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412).end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(req.headers.range ?? '');
    const first = range ? Number(range[1]) : 0;
    const last = range && range[2] ? Number(range[2]) : contents.length - 1;
    res.setHeader('etag', etag);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', last - first + 1);
    if (range) res.setHeader('content-range', `bytes ${first}-${last}/${contents.length}`);
    res.writeHead(range ? 206 : 200);
    res.end(req.method === 'HEAD' ? undefined : contents.subarray(first, last + 1));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const resolved = join(tmpdir(), root.split(/[\\/]/u).at(-1));
    assert.equal(root, resolved);
    await rm(root, { recursive: true });
  });
  return { root, output, requests, contents, etag, url: `http://127.0.0.1:${server.address().port}/payload.bin` };
}

function invoke(output, command, args = [], env = { ...process.env, PATH: '' }) {
  return run(process.execPath, [cli, command, '--out', output, ...args], { env, timeout: 35_000 });
}

test('benchmarks downloads, preserves verified output on restart, and detects same-size corruption', async t => {
  const { root, output, requests, contents, url } = await fixture(t);
  const manifest = join(root, 'sample.json');
  await writeFile(manifest, JSON.stringify(['payload.bin', 'second.bin'].map(path => ({
    path, url, size: contents.length, sha256: sha(contents),
  }))));
  const result = await invoke(output, 'run', ['--manifest', manifest, '--concurrency', '1,2']);
  assert.match(result.stdout, /Benchmark small/u);
  assert.match(result.stdout, /Download complete/u);
  const dest = join(output, 'payload.bin');
  assert.deepEqual(await readFile(dest), contents);
  const report = JSON.parse(await readFile(join(output, '.adaptive-download', 'strategy.json'), 'utf8'));
  assert.equal(report.groups.small.trials.filter(trial => trial.mibPerSecond).length, 2);
  const requestCount = requests.length;
  await invoke(output, 'run');
  assert.equal(requests.length, requestCount);
  await invoke(output, 'verify');
  await writeFile(dest, Buffer.alloc(contents.length));
  await assert.rejects(invoke(output, 'verify'), /Checksum mismatch/u);
});

test('downloads a single direct link without testing equivalent concurrency settings', async t => {
  const { output, requests, contents, url } = await fixture(t);
  const result = await invoke(output, 'run', ['--source', url]);
  assert.match(result.stdout, /http 1 \(one configuration\)/u);
  assert.deepEqual(requests, ['full']);
  assert.deepEqual(await readFile(join(output, 'payload.bin')), contents);
});

test('continues a saved HTTP partial using an If-Match protected Range request', async t => {
  const { output, contents, requests, url } = await fixture(t);
  await invoke(output, 'bench', ['--source', url, '--skip-benchmark']);
  const parts = join(output, '.adaptive-download', 'parts', 'http', sha('payload.bin'));
  await mkdir(parts, { recursive: true });
  await writeFile(join(parts, 'payload'), contents.subarray(0, 100));
  await invoke(output, 'run');
  assert.deepEqual(requests, ['bytes=100-']);
  assert.deepEqual(await readFile(join(output, 'payload.bin')), contents);
});

test('rejects conflicting existing files and non-portable manifest paths', async t => {
  const { root, output, contents, url, requests } = await fixture(t);
  await mkdir(output);
  const foreign = Buffer.alloc(contents.length, 23);
  await writeFile(join(output, 'payload.bin'), foreign);
  await assert.rejects(invoke(output, 'run', ['--source', url]), /Conflicting or unverified/u);
  assert.deepEqual(await readFile(join(output, 'payload.bin')), foreign);
  assert.equal(requests.length, 0);
  const manifest = join(root, 'bad.json');
  await writeFile(manifest, JSON.stringify([{ url, size: contents.length, path: '../outside.bin' }]));
  await assert.rejects(invoke(join(root, 'different'), 'run', ['--manifest', manifest]), /Unsafe or non-portable/u);
});

test('downloads and verifies through aria2 when installed', { skip: !process.env.TEST_ARIA2 }, async t => {
  const { output, contents, url, requests } = await fixture(t, Buffer.alloc(18 * 1024 ** 2, 43));
  await invoke(output, 'bench', ['--source', url, '--skip-benchmark'], process.env);
  const parts = join(output, '.adaptive-download', 'parts', 'aria2', sha('payload.bin'));
  await mkdir(parts, { recursive: true });
  // Simulate a stop after the last segment wrote bytes but before a control file was saved.
  await writeFile(join(parts, 'payload'), Buffer.alloc(contents.length));
  const result = await invoke(output, 'run', [], process.env);
  assert.match(result.stdout, /large: aria2/u);
  assert(requests.some(range => range.startsWith('bytes=')));
  assert.equal(sha(await readFile(join(output, 'payload.bin'))), sha(contents));
  await invoke(output, 'verify');
});
