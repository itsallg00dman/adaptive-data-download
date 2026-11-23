#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execute } from '../src/runner.mjs';
import { discoverTools } from '../src/transfer.mjs';

const help = `Adaptive Data Download

  node bin/download.mjs run --source <s3://bucket/prefix/ | https://host/file> --out <folder>
  node bin/download.mjs run --manifest <files.json> --out <folder>
  node bin/download.mjs run --out <folder>            Continue a saved download
  node bin/download.mjs bench --out <folder>          Measure and save a strategy
  node bin/download.mjs verify --out <folder>         Re-read and verify downloaded files
  node bin/download.mjs doctor                       Check optional tools

Options
  --scope <all|raw|slim>     Public S3 filter (default: all)
  --region <name>            S3 region (default: us-east-1)
  --name <file>              Output filename for a single HTTP URL
  --concurrency <list>       Candidate widths (default: 4,8,16; up to 5 values)
  --bench-mib <n>            Maximum MiB per candidate and size group (default: 32)
  --bench-seconds <n>        Maximum seconds per candidate (default: 15)
  --skip-benchmark           Start with the built-in default strategy
  --retest                   Rebuild the saved strategy for unfinished files
  --etag-md5                 Treat plain S3 ETags as MD5 only for a confirmed source
  --recover-lock             Remove a stale lock after an interrupted shutdown

Ctrl+C pauses the current command. Keep the output folder and .adaptive-download directory.`;

const definitions = {
  source: { type: 'string' }, manifest: { type: 'string' }, out: { type: 'string' },
  scope: { type: 'string', default: 'all' }, region: { type: 'string', default: 'us-east-1' },
  name: { type: 'string' }, concurrency: { type: 'string', default: '4,8,16' },
  'bench-mib': { type: 'string', default: '32' }, 'bench-seconds': { type: 'string', default: '15' },
  'skip-benchmark': { type: 'boolean' }, retest: { type: 'boolean' },
  'etag-md5': { type: 'boolean' }, 'recover-lock': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function integer(value, label, min, max) {
  if (!/^\d+$/u.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

async function main(signalController) {
  const { values, positionals } = parseArgs({ options: definitions, allowPositionals: true });
  if (values.help || !process.argv.slice(2).length) { console.log(help); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['run', 'bench', 'verify', 'doctor'].includes(command)) throw new Error('Choose run, bench, verify or doctor. Use --help for examples.');
  const tools = await discoverTools(signalController.signal);
  signalController.signal.throwIfAborted();
  if (command === 'doctor') {
    console.log(`Node.js ${process.versions.node}\nHTTP: built in\nAWS CLI v2: ${tools.aws ? 'available' : 'missing (required for S3 listings)'}\naria2: ${tools.aria2 ? 'available' : 'not installed (optional)'}`);
    return;
  }
  if (!values.out?.trim()) throw new Error('Specify --out <folder>');
  if (values.source && values.manifest) throw new Error('Choose either --source or --manifest');
  if (!['all', 'raw', 'slim'].includes(values.scope)) throw new Error('Choose scope all, raw or slim');
  const concurrency = [...new Set(values.concurrency.split(',').map(item => integer(item, 'Concurrency', 1, 32)))].sort((a, b) => a - b);
  if (concurrency.length > 5) throw new Error('Choose at most 5 candidate widths');
  await execute(command, {
    ...values, concurrency, benchMiB: integer(values['bench-mib'], 'Benchmark MiB', 1, 16384),
    benchSeconds: integer(values['bench-seconds'], 'Benchmark seconds', 1, 3600),
    skipBenchmark: !!values['skip-benchmark'], recoverLock: !!values['recover-lock'], etagMd5: !!values['etag-md5'],
  }, tools, signalController);
}

const controller = new AbortController();
const pause = () => controller.abort(new Error('Paused. Continue with run --out <folder>.'));
process.on('SIGINT', pause);
process.on('SIGTERM', pause);
try { await main(controller); }
catch (error) { console.error(error.message); process.exitCode = controller.signal.reason?.message.startsWith('Paused.') ? 130 : 1; }
finally { process.off('SIGINT', pause); process.off('SIGTERM', pause); }
