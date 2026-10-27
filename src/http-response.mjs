import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

function encodingFor(header) {
  const values = new Map(String(header || '').toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0];
  }));
  return ['br', 'gzip'].map(name => ({ name, q: values.get(name) ?? values.get('*') ?? 0 }))
    .filter(value => value.q > 0).sort((a, b) => b.q - a.q)[0]?.name;
}

// Compress buffered text only. SSE keeps its own unbuffered response path.
export async function sendText(res, status, value, type, { cacheControl, validate = false } = {}) {
  const req = res.req;
  let body = Buffer.from(value);
  const headers = { 'content-type': type, vary: 'Accept-Encoding' };
  if (cacheControl) headers['cache-control'] = cacheControl;
  if (validate) {
    const tag = '"' + createHash('sha256').update(body).digest('hex') + '"';
    headers.etag = 'W/' + tag;
    const matches = String(req.headers['if-none-match'] || '').split(',')
      .some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === tag);
    if (matches && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(304, headers); return res.end();
    }
  }
  const encoding = body.length >= 1024 ? encodingFor(req.headers['accept-encoding']) : null;
  if (encoding) {
    const compressed = encoding === 'br'
      ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
      : await compressGzip(body);
    if (compressed.length < body.length) { body = compressed; headers['content-encoding'] = encoding; }
  }
  if (res.destroyed) return;
  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
