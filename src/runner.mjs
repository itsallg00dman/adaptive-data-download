import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { largeFile, listS3, loadHttp, MiB } from './sources.mjs';
import { checkStage, diskSpace, ensureDir, existing, hashFile, stagePath, transfer } from './transfer.mjs';

const sum = files => files.reduce((n, file) => n + file.size, 0);
const sizeText = bytes => `${(bytes / MiB).toFixed(1)} MiB`;
const rangeSafe = file => !!(file.etag || file.sha256 || file.md5);
const groupOf = file => file.size >= largeFile ? 'large' : 'small';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function saveJson(path, data) {
  const temp = `${path}.${randomUUID()}.new`;
  const fd = await open(temp, 'wx');
  try { await fd.writeFile(JSON.stringify(data, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temp, path);
}

async function useLock(state, recover) {
  const path = join(state, 'lock.json');
  const lock = { pid: process.pid, host: hostname(), id: randomUUID() };
  if (recover && await existing(path)) {
    let previous;
    try { previous = await readJson(path); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (previous?.host === lock.host && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new Error('Another download process is using this directory');
    }
    await rm(path);
  }
  try { await writeFile(path, JSON.stringify(lock), { flag: 'wx', flush: true }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Directory is locked. After confirming no process is using it, retry with --recover-lock.');
    throw error;
  }
  return async () => {
    try { if ((await readJson(path)).id === lock.id) await rm(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

function leaf(root, file) { return join(root, ...file.path.split('/')); }

async function readJournal(state) {
  const path = join(state, 'completed.jsonl');
  const text = await existing(path) ? await readFile(path, 'utf8') : '';
  const records = new Map();
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (/^[a-f0-9]{64}$/u.test(row.sha256)) records.set(row.path, row);
    } catch { /* An interrupted final append can leave an incomplete record. */ }
  }
  return records;
}

async function inspect(root, plan, state, signal, verify) {
  const saved = await readJournal(state);
  const pending = [];
  const problems = [];
  for (const file of plan.files) {
    signal.throwIfAborted();
    const dest = leaf(root, file);
    // Check ancestors before reading or adopting an existing path.
    const ancestors = file.path.split('/').slice(0, -1);
    let parent = root;
    for (const dir of ancestors) {
      parent = join(parent, dir);
      const info = await existing(parent);
      if (!info) break;
      if (!info.isDirectory()) throw new Error(`Unsafe destination directory: ${parent}`);
    }
    const info = await existing(dest);
    const record = saved.get(file.path);
    const expected = record?.size === file.size ? record.sha256 : file.sha256;
    if (!info) { pending.push(file); continue; }
    if (!info.isFile() || info.size !== file.size || (!expected && !file.md5)) {
      problems.push(`Conflicting or unverified existing file: ${file.path}`);
    } else if (verify || !record || info.mtimeMs !== record.mtimeMs) {
      try { await hashFile(dest, file, signal, expected); } catch (error) {
        signal.throwIfAborted(); problems.push(error.message);
      }
    }
  }
  return { pending, problems };
}

function candidates(files, group, { source, tools, options }) {
  const configs = [];
  if (source.type === 's3' && tools.aws) {
    for (const jobs of options.concurrency) configs.push({ engine: 'aws', jobs });
  }
  if (tools.aria2 && files.every(rangeSafe)) {
    for (const width of options.concurrency) {
      configs.push(group === 'large' ? { engine: 'aria2', jobs: Math.min(2, files.length), parts: Math.min(16, Math.max(1, Math.floor(width / 2))) } :
        { engine: 'aria2', jobs: width, parts: 1 });
    }
  }
  for (const jobs of options.concurrency) configs.push({ engine: 'http', jobs });
  return configs;
}

function defaultConfig(files, group, { source, tools, options }) {
  const jobs = options.concurrency.reduce((best, value) => Math.abs(value - 8) < Math.abs(best - 8) ? value : best);
  if (group === 'large' && tools.aria2 && files.every(rangeSafe)) return { engine: 'aria2', jobs: 2, parts: 4 };
  return { engine: source.type === 's3' && tools.aws ? 'aws' : 'http', jobs };
}

function representative(files, budget) {
  const eligible = files.filter(file => file.size > 0 && file.size <= budget);
  if (!eligible.length) return [];
  const sample = [];
  const count = Math.min(64, eligible.length);
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const file = eligible[Math.floor(i * eligible.length / count)];
    if (bytes + file.size <= budget) { sample.push(file); bytes += file.size; }
  }
  return sample;
}

const label = config => config.engine === 'aria2' ? `aria2 ${config.jobs} × ${config.parts}` : `${config.engine} ${config.jobs}`;
const pressure = config => config.jobs * (config.parts ?? 1);

async function tune(files, group, work, context) {
  const { options, signal } = context;
  const sample = representative(files, options.benchMiB * MiB);
  const variants = candidates(files, group, context);
  const baseline = defaultConfig(files, group, context);
  if (options.skipBenchmark || !sample.length || variants.length === 1) {
    const reason = options.skipBenchmark ? 'disabled' : !sample.length ? 'no complete sample within budget' : 'one configuration';
    return { selected: baseline, reason, trials: [] };
  }
  if (await diskSpace(work) < BigInt(sum(sample))) throw new Error('Insufficient free space for the benchmark sample');
  const trials = [];
  const benchRoot = await ensureDir(work, `bench-${randomUUID()}`);
  try {
    console.log(`Benchmark ${group}: ${sample.length} files, ${sizeText(sum(sample))} per attempt`);
    // Try a low and a medium request count per tool before higher concurrency.
    const engines = [...new Set(variants.map(item => item.engine))];
    const ordered = options.concurrency.flatMap((_, index) => engines.map(engine => variants.filter(item => item.engine === engine)[index]));
    for (const config of ordered) {
      signal.throwIfAborted();
      const trialDir = await ensureDir(benchRoot, randomUUID());
      const trialSignal = AbortSignal.any([signal, AbortSignal.timeout(options.benchSeconds * 1000)]);
      const start = performance.now();
      try {
        await transfer(sample, config, trialDir, { ...context, signal: trialSignal });
        for (const file of sample) {
          if (!await checkStage(trialDir, config.engine, file, trialSignal, true)) throw new Error(`Incomplete sample: ${file.path}`);
        }
        const seconds = (performance.now() - start) / 1000;
        const mibPerSecond = sum(sample) / MiB / seconds;
        trials.push({ config, seconds, mibPerSecond });
        console.log(`  ${label(config)}  ${mibPerSecond.toFixed(2)} MiB/s`);
      } catch (error) {
        signal.throwIfAborted();
        trials.push({ config, error: error.message });
        console.log(`  ${label(config)}  ${trialSignal.aborted ? 'timed out' : 'failed'}`);
      } finally { if (await existing(trialDir)) await rm(trialDir, { recursive: true }); }
    }
  } finally { if (await existing(benchRoot)) await rm(benchRoot, { recursive: true }); }
  const finished = trials.filter(trial => trial.mibPerSecond !== undefined);
  const peak = Math.max(0, ...finished.map(trial => trial.mibPerSecond));
  const best = finished.filter(trial => trial.mibPerSecond >= peak * 0.95)
    .sort((a, b) => pressure(a.config) - pressure(b.config) || b.mibPerSecond - a.mibPerSecond)[0];
  return { selected: best?.config ?? baseline, reason: best ? 'completed sample throughput' : 'all samples failed',
    sample: { files: sample.length, bytes: sum(sample) }, trials };
}

async function select(files, state, context) {
  const path = join(state, 'strategy.json');
  let report = !context.options.retest && await existing(path) ? await readJson(path) : { groups: {} };
  for (const group of ['small', 'large']) {
    const items = files.filter(file => groupOf(file) === group);
    if (!items.length) continue;
    if (!report.groups[group]) {
      const result = await tune(items, group, state, context);
      report.groups[group] = result;
      report = { ...report, measuredAt: new Date().toISOString() };
      await saveJson(path, report);
    }
    const result = report.groups[group];
    if (result.selected.engine !== 'http' && !context.tools[result.selected.engine]) {
      throw new Error(`Missing ${result.selected.engine}. Install it or use --retest to select an available engine.`);
    }
    console.log(`${group}: ${label(result.selected)} (${result.reason})`);
  }
  return report;
}

async function promote(root, state, parts, engine, files, signal, checkTarget, transferSucceeded = false) {
  const remaining = [];
  const ready = [];
  for (const file of files) {
    signal.throwIfAborted();
    const sha256 = await checkStage(parts, engine, file, signal, transferSucceeded);
    if (!sha256) { remaining.push(file); continue; }
    await checkTarget();
    const stage = stagePath(parts, engine, file);
    const dest = leaf(root, file);
    const info = await existing(stage);
    const parent = posix.dirname(file.path);
    await ensureDir(root, parent === '.' ? '' : parent);
    if (await existing(dest)) throw new Error(`Destination already exists: ${file.path}`);
    const record = { path: file.path, size: file.size, sha256, mtimeMs: info.mtimeMs, time: new Date().toISOString() };
    ready.push({ stage, dest, record });
  }
  if (ready.length) {
    const rows = ready.map(item => JSON.stringify(item.record)).join('\n');
    await appendFile(join(state, 'completed.jsonl'), '\n' + rows + '\n', { flush: true });
    for (const { stage, dest } of ready) { await checkTarget(); await rename(stage, dest); }
  }
  return remaining;
}

async function download(root, state, files, report, context, checkTarget) {
  const { signal } = context;
  const parts = await ensureDir(state, 'parts');
  let done = 0, bytes = 0;
  const total = sum(files);
  for (const group of ['small', 'large']) {
    const items = files.filter(file => groupOf(file) === group);
    if (!items.length) continue;
    let config = report.groups[group].selected;
    const batchSize = config.engine === 'aws' ? 120 : group === 'large' ? Math.max(2, config.jobs * 2) : 64;
    for (let index = 0; index < items.length; index += batchSize) {
      const batch = items.slice(index, index + batchSize);
      const start = performance.now();
      await checkTarget();
      let pending = await promote(root, state, parts, config.engine, batch, signal, checkTarget);
      let lastError;
      for (let attempt = 0; pending.length && attempt < 3; attempt++) {
        signal.throwIfAborted();
        let succeeded = false;
        try { await transfer(pending, config, parts, context); succeeded = true; }
        catch (error) { signal.throwIfAborted(); lastError = error; }
        pending = await promote(root, state, parts, config.engine, pending, signal, checkTarget, succeeded);
        if (pending.length && attempt < 2) {
          config = { ...config, jobs: Math.max(1, Math.floor(config.jobs / 2)) };
          if (config.parts) config.parts = Math.max(1, Math.floor(config.parts / 2));
          console.log(`Retrying ${pending.length} files at ${label(config)}`);
          const { setTimeout } = await import('node:timers/promises');
          await setTimeout(1000 * (attempt + 1), undefined, { signal });
        }
      }
      if (pending.length) throw new Error(`Incomplete batch (${pending.length} files), first: ${pending[0].path}${lastError ? `\n${lastError.message}` : ''}`);
      done += batch.length;
      bytes += sum(batch);
      console.log(`${done}/${files.length} pending files complete · ${sizeText(bytes)}/${sizeText(total)} · ${(sum(batch) / MiB / ((performance.now() - start) / 1000)).toFixed(1)} MiB/s in this batch`);
    }
  }
}

export async function execute(command, options, tools, controller) {
  const signal = controller.signal;
  const output = resolve(options.out);
  const rootExists = await existing(output);
  if (!rootExists && (command === 'verify' || (!options.source && !options.manifest))) throw new Error('No saved task in this output directory');
  await mkdir(output, { recursive: true });
  if (!(await existing(output))?.isDirectory()) throw new Error('Use a real output directory');
  const root = await realpath(output);
  const state = await ensureDir(root, '.adaptive-download');
  const unlock = await useLock(state, options.recoverLock);
  const marker = join(state, 'target-id');
  let watch;
  try {
    if (!await existing(marker)) await writeFile(marker, randomUUID(), { flag: 'wx', flush: true });
    const targetId = await readFile(marker, 'utf8');
    const checkTarget = async () => {
      signal.throwIfAborted();
      if (await readFile(marker, 'utf8').catch(() => '') !== targetId) throw new Error('Target directory is missing or has changed');
    };
    watch = setInterval(() => checkTarget().catch(error => controller.abort(error)), 2000);
    watch.unref();
    const planPath = join(state, 'manifest.json');
    let plan;
    if (await existing(planPath)) {
      plan = await readJson(planPath);
      if (options.source || options.manifest) {
        const request = JSON.stringify([options.source, options.manifest ? resolve(options.manifest) : null,
          options.scope, options.region, options.name, options.etagMd5]);
        if (plan.request !== request) throw new Error('This directory already has a different saved task. Use a new directory or resume with --out only.');
      }
      const { validateFiles } = await import('./sources.mjs');
      plan.files = validateFiles(plan.files);
    } else {
      if (command === 'verify' || (!options.source && !options.manifest)) throw new Error('No saved task. Supply --source or --manifest first.');
      const result = options.source?.startsWith('s3:') ? await listS3(options.source, { ...options, tools, signal }) :
        await loadHttp({ url: options.source, manifest: options.manifest, name: options.name, signal });
      plan = { ...result, version: 1, createdAt: new Date().toISOString(),
        request: JSON.stringify([options.source, options.manifest ? resolve(options.manifest) : null,
          options.scope, options.region, options.name, options.etagMd5]) };
      await saveJson(planPath, plan);
    }
    const { pending, problems } = await inspect(root, plan, state, signal, command === 'verify');
    if (problems.length) throw new Error(`${problems.length} local file conflicts:\n${problems.slice(0, 5).join('\n')}\nMove the affected files aside before retrying.`);
    console.log(`${plan.files.length} files · ${sizeText(sum(plan.files))} total · ${pending.length} remaining`);
    if (command === 'verify') {
      if (pending.length) throw new Error(`Missing ${pending.length} files; first missing: ${pending[0].path}`);
      console.log('All files match their recorded checksums.');
    } else if (pending.length) {
      const context = { options, source: plan.source, tools, signal };
      const report = await select(pending, state, { ...context, options: { ...options, retest: options.retest || command === 'bench' } });
      if (command === 'run') {
        const free = await diskSpace(root);
        let needed = 0n;
        for (const file of pending) {
          const engine = report.groups[groupOf(file)].selected.engine;
          const part = await existing(stagePath(join(state, 'parts'), engine, file));
          needed += BigInt(file.size - (part?.isFile() && engine !== 'aria2' ? Math.min(part.size, file.size) : 0));
        }
        if (free < needed + 8n * BigInt(MiB)) throw new Error('Insufficient free space for the remaining files and 8 MiB of metadata');
        await download(root, state, pending, report, context, checkTarget);
        console.log('Download complete.');
      }
    } else console.log('All files in the saved task are present.');
  } finally {
    clearInterval(watch);
    await unlock().catch(error => console.error(`Could not release task lock: ${error.message}`));
  }
}
