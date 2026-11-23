import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

export const MiB = 1024 ** 2;
export const largeFile = 16 * MiB;

export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid file path');
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[<>:"\\|?*\x00-\x20]$/u.test(segment) ||
        /[<>:"\\|?*\x00-\x1f\x7f]/u.test(segment) || /\.$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment) ||
        segment.toLowerCase() === '.adaptive-download') {
      throw new Error(`Unsafe or non-portable file path: ${JSON.stringify(value)}`);
    }
  }
  return value;
}

export function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Use an HTTP(S) URL without embedded credentials or fragments');
  }
  return url.href;
}

export function strongEtag(value) {
  return typeof value === 'string' && /^"[\x21\x23-\x7e]+"$/u.test(value);
}

function fileEntry(entry) {
  const path = safePath(entry.path);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid byte size: ${path}`);
  for (const [name, width] of [['sha256', 64], ['md5', 32]]) {
    if (entry[name] !== undefined && !new RegExp(`^[a-fA-F0-9]{${width}}$`, 'u').test(entry[name])) {
      throw new Error(`Invalid ${name}: ${path}`);
    }
  }
  if (entry.etag !== undefined && !strongEtag(entry.etag)) throw new Error(`Invalid strong ETag: ${path}`);
  return {
    path, url: httpUrl(entry.url), size: entry.size, etag: entry.etag,
    sha256: entry.sha256?.toLowerCase(), md5: entry.md5?.toLowerCase(),
    key: entry.key, modified: entry.modified,
  };
}

export function validateFiles(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('No files selected');
  const seen = new Map();
  const files = entries.map(fileEntry);
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const path = segments.slice(0, i).join('/');
      const key = path.normalize('NFC').toLowerCase();
      const directory = i < segments.length;
      const prior = seen.get(key);
      if (prior && (!directory || !prior.directory || prior.path !== path)) {
        throw new Error(`File path collision: ${path}`);
      }
      seen.set(key, { path, directory });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : Number(a.path !== b.path)));
}

function matchesScope(path, scope) {
  if (scope === 'all') return true;
  if (scope === 'slim') return path.startsWith('RawDataTars/') || (!path.includes('/') && /\.tsv$/iu.test(path));
  return !/(^|\/)derivatives\//iu.test(path) && path !== 'mosaic.jpg' &&
    (path === '.bidsignore' || !path.split('/').some(part => part.startsWith('.')));
}

export async function listS3(input, { tools, scope, region, etagMd5, signal }) {
  if (!tools.aws) throw new Error('Public S3 listing requires AWS CLI v2 on PATH. Run doctor for tool status.');
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/u.exec(input);
  if (!match || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/u.test(region)) throw new Error('Invalid S3 bucket, prefix or region');
  const [, bucket, prefix = ''] = match;
  if (prefix && !prefix.endsWith('/')) throw new Error('End the S3 directory prefix with /');
  const { runProcess } = await import('./transfer.mjs');
  const source = { type: 's3', input, bucket, prefix, region, scope, etagMd5 };
  const { stdout } = await runProcess(tools.aws, [
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--region', region,
    '--no-sign-request', '--no-cli-pager', '--output', 'json',
  ], { signal, collect: true });
  const result = JSON.parse(stdout);
  if (result.IsTruncated || result.NextToken) throw new Error('S3 listing was incomplete');
  const files = (result.Contents ?? []).flatMap(object => {
    const key = object.Key;
    if (!key.startsWith(prefix) || key.endsWith('/')) return [];
    const path = key.slice(prefix.length);
    if (!matchesScope(path, scope)) return [];
    const domain = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
    const url = `https://s3.${region}.${domain}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const etag = strongEtag(object.ETag) ? object.ETag : undefined;
    const md5 = etagMd5 && /^"[a-f0-9]{32}"$/iu.test(etag) ? etag.slice(1, -1) : undefined;
    return [{ path, url, size: object.Size, etag, md5, key, modified: object.LastModified }];
  });
  return { source, files: validateFiles(files) };
}

export async function loadHttp({ url, manifest, name, signal }) {
  if (manifest) {
    const data = JSON.parse(await readFile(manifest, 'utf8'));
    return { source: { type: 'http', manifest: true }, files: validateFiles(data.files ?? data) };
  }
  const href = httpUrl(url);
  const response = await fetch(href, {
    method: 'HEAD', headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const length = response.headers.get('content-length');
  if (!response.ok || !/^\d+$/u.test(length) ||
      (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
    throw new Error('The URL must report its uncompressed Content-Length via HEAD. Use a manifest if HEAD is unsupported.');
  }
  const path = name ?? decodeURIComponent(posix.basename(new URL(href).pathname));
  const etag = response.headers.get('etag');
  return { source: { type: 'http', input: href }, files: validateFiles([
    { path, url: href, size: Number(length), etag: strongEtag(etag) ? etag : undefined },
  ]) };
}
