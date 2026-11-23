import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MiB } from './sources.mjs';

export function runProcess(executable, args, { signal, collect = false, env = process.env } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnError;
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', data => {
      if (!collect) return;
      stdout += data;
      if (stdout.length > 100 * MiB) { spawnError = new Error('Command output exceeds 100 MiB'); stop(); }
    });
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-1800); });
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(signal.reason);
      else if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`${executable} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      else resolve({ stdout });
    });
  });
}

export async function discoverTools(signal) {
  const found = await Promise.all(['aws', 'aria2c'].map(async command => {
    try {
      const { stdout } = await runProcess(command, ['--version'], {
        collect: true, signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      });
      return [command, stdout.split(/\r?\n/u)[0]];
    } catch { return [command, null]; }
  }));
  return Object.fromEntries(found.map(([command, version]) => [command === 'aria2c' ? 'aria2' : command,
    command === 'aws' && !version?.startsWith('aws-cli/2.') ? null : version ? command : null]));
}

export const identity = text => createHash('sha256').update(text).digest('hex');

export async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function ensureDir(root, relative = '') {
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    current = join(current, segment);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(current)).isDirectory()) throw new Error(`Expected a real directory: ${current}`);
  }
  return current;
}

export function stagePath(root, engine, file) {
  return engine === 'aws' ? join(root, 'aws', ...file.path.split('/')) :
    join(root, engine, identity(file.path), 'payload');
}

export async function hashFile(path, file, signal, expected = file.sha256) {
  const info = await lstat(path);
  if (!info.isFile() || info.size !== file.size) throw new Error(`Wrong file length: ${file.path}`);
  const sha = createHash('sha256');
  const md5 = file.md5 && createHash('md5');
  for await (const chunk of createReadStream(path, { signal })) { sha.update(chunk); md5?.update(chunk); }
  const value = sha.digest('hex');
  if ((expected && value !== expected) || (md5 && md5.digest('hex') !== file.md5)) {
    throw new Error(`Checksum mismatch: ${file.path}`);
  }
  return value;
}

async function httpFile(file, path, signal) {
  const idle = new AbortController();
  const requestSignal = AbortSignal.any([signal, idle.signal]);
  let timer;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`HTTP idle timeout: ${file.path}`)), 45_000);
    timer.unref();
  };
  try { await streamHttpFile(file, path, requestSignal, resetIdleTimer); }
  finally { clearTimeout(timer); }
}

async function streamHttpFile(file, path, signal, resetIdleTimer) {
  const prior = await existing(path);
  if (prior && !prior.isFile()) throw new Error(`Unexpected partial path: ${path}`);
  const sameVersion = file.etag || file.sha256 || file.md5;
  let offset = sameVersion && prior && prior.size <= file.size ? prior.size : 0;
  if (offset && offset === file.size) return;
  if (file.size === 0) { await writeFile(path, ''); return; }
  const request = async start => {
    resetIdleTimer();
    const headers = { 'accept-encoding': 'identity' };
    if (file.etag) headers['if-match'] = file.etag;
    if (start) headers.range = `bytes=${start}-`;
    return fetch(file.url, { headers, signal, redirect: 'follow' });
  };
  let response = await request(offset);
  if (offset && response.status === 416) {
    await response.body?.cancel();
    offset = 0;
    response = await request(0);
  }
  if (response.status === 200) offset = 0;
  const range = response.headers.get('content-range');
  const etag = response.headers.get('etag');
  const encoding = response.headers.get('content-encoding');
  if ((offset ? response.status !== 206 || range !== `bytes ${offset}-${file.size - 1}/${file.size}` : response.status !== 200) ||
      (file.etag && etag !== file.etag && (etag || (offset && !file.sha256 && !file.md5))) ||
      (encoding && encoding !== 'identity') || !response.body) {
    await response.body?.cancel();
    throw new Error(`Unexpected HTTP response ${response.status} for ${file.path}`);
  }
  let received = offset;
  const limit = new Transform({ transform(chunk, _encoding, done) {
    resetIdleTimer();
    received += chunk.length;
    done(received > file.size ? new Error(`Response exceeds expected size: ${file.path}`) : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: offset ? 'a' : 'w' }), { signal });
  if (received !== file.size) throw new Error(`Incomplete HTTP response: ${file.path}`);
}

function sharedParent(files) {
  const first = files[0].path.split('/').slice(0, -1);
  const last = files.at(-1).path.split('/').slice(0, -1);
  let length = 0;
  while (length < first.length && first[length] === last[length]) length++;
  return first.slice(0, length).join('/');
}

async function awsBatch(files, source, config, root, executable, signal) {
  const directory = await ensureDir(root, 'aws');
  const configFile = join(root, 'aws-config');
  await writeFile(configFile, `[default]\nregion = ${source.region}\nretry_mode = standard\nmax_attempts = 4\ns3 =\n    preferred_transfer_client = classic\n    max_concurrent_requests = ${config.jobs}\n`, 'utf8');
  const env = { ...process.env, AWS_CONFIG_FILE: configFile, AWS_PROFILE: 'default', AWS_PAGER: '',
    AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '4' };
  const options = ['--no-sign-request', '--no-progress', '--region', source.region,
    '--cli-connect-timeout', '15', '--cli-read-timeout', '45'];
  let start = 0;
  while (start < files.length) {
    let end = start + 1;
    let length = Buffer.byteLength(files[start].path) + 14;
    while (end < files.length && end - start < 120 && length + Buffer.byteLength(files[end].path) + 14 < 6000) {
      length += Buffer.byteLength(files[end++].path) + 14;
    }
    const group = files.slice(start, end);
    if (group.length === 1) {
      const file = group[0];
      const local = stagePath(root, 'aws', file);
      await runProcess(executable, ['s3', 'cp', `s3://${source.bucket}/${source.prefix}${file.path}`, local, ...options], { signal, env });
    } else {
      const parent = sharedParent(group);
      const prefix = parent ? parent + '/' : '';
      const local = parent ? join(directory, ...parent.split('/')) : directory;
      const include = group.map(file => '--include=' + file.path.slice(prefix.length).replaceAll('[', '[[]'));
      await runProcess(executable, [
        's3', 'cp', `s3://${source.bucket}/${source.prefix}${prefix}`, local, '--recursive', '--exclude=*', ...include, ...options,
      ], { signal, env });
    }
    start = end;
  }
}

async function ariaBatch(files, config, root, executable, signal) {
  const input = join(root, 'aria2-input.txt');
  const entries = files.map(file => {
    const path = stagePath(root, 'aria2', file);
    const options = [`dir=${dirname(path)}`, 'out=payload'];
    if (file.etag) options.push(`header=If-Match: ${file.etag}`);
    if (file.sha256) options.push(`checksum=sha-256=${file.sha256}`);
    else if (file.md5) options.push(`checksum=md5=${file.md5}`);
    return [file.url, ...options.map(option => '  ' + option)].join('\n');
  });
  await writeFile(input, entries.join('\n') + '\n', 'utf8');
  await runProcess(executable, [
    `--input-file=${input}`, '--continue=true', '--always-resume=false', '--auto-file-renaming=false',
    '--file-allocation=none', '--auto-save-interval=5', '--max-tries=3', '--retry-wait=2',
    '--connect-timeout=15', '--timeout=45', '--summary-interval=0', '--console-log-level=error',
    '--enable-color=false', '--no-conf=true', '--check-integrity=true', '--http-accept-gzip=false',
    '--header=Accept-Encoding: identity',
    `--max-concurrent-downloads=${config.jobs}`, `--split=${config.parts}`,
    `--max-connection-per-server=${config.parts}`, '--min-split-size=4M',
  ], { signal });
}

async function concurrent(files, width, transfer, signal) {
  let next = 0;
  const failures = [];
  await Promise.all(Array.from({ length: Math.min(width, files.length) }, async () => {
    while (next < files.length && !signal.aborted) {
      const file = files[next++];
      try { await transfer(file); } catch (error) { failures.push(error); }
    }
  }));
  signal.throwIfAborted();
  if (failures.length) throw failures[0];
}

export async function transfer(files, config, root, { tools, source, signal }) {
  if (!files.length) return;
  const engine = config.engine;
  for (const file of files) {
    const relative = engine === 'aws' ? posix.dirname('aws/' + file.path) : `${engine}/${identity(file.path)}`;
    const directory = await ensureDir(root, relative);
    if (/[\r\n]/u.test(directory)) throw new Error('Use an output path without line breaks');
    const path = stagePath(root, engine, file);
    const prior = await existing(path);
    const control = engine === 'aria2' && await existing(path + '.aria2');
    if ((prior && !prior.isFile()) || (control && !control.isFile())) throw new Error(`Unsafe transfer file: ${path}`);
    // The last segment can reach the expected file length before the first control-file save.
    if (engine === 'aria2' && prior && !control) await rm(path);
  }
  if (engine === 'aws') await awsBatch(files, source, config, root, tools.aws, signal);
  else if (engine === 'aria2') await ariaBatch(files, config, root, tools.aria2, signal);
  else await concurrent(files, config.jobs, file => httpFile(file, stagePath(root, engine, file), signal), signal);
}

export async function checkStage(root, engine, file, signal, transferSucceeded = false) {
  const path = stagePath(root, engine, file);
  const info = await existing(path);
  if (!info || !info.isFile() || info.size !== file.size) return null;
  if (engine === 'aria2' && (await existing(path + '.aria2') || (!transferSucceeded && !file.sha256 && !file.md5))) return null;
  try { return await hashFile(path, file, signal); }
  catch (error) {
    if (signal.aborted || !error.message.startsWith('Checksum mismatch:')) throw error;
    await rm(path);
    return null;
  }
}

export async function diskSpace(root) {
  const fs = await statfs(root, { bigint: true });
  return fs.bavail * fs.bsize;
}
