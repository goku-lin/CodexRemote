import test from 'node:test';
import assert from 'node:assert/strict';
import {TextRenderCache} from '../public/render-cache.js';

test('unchanged text reuses HTML while modified text is rendered again', () => {
  const cache = new TextRenderCache();
  let calls = 0;
  const compute = text => { calls++; return '<p>' + text + '</p>'; };
  assert.equal(cache.render('first', compute), '<p>first</p>');
  assert.equal(cache.render('first', compute), '<p>first</p>');
  assert.equal(calls, 1);
  assert.equal(cache.render('first update', compute), '<p>first update</p>');
  assert.equal(calls, 2);
});

test('streaming versions respect both byte and entry limits, retaining recent hits', () => {
  const cache = new TextRenderCache({maxEntries: 2, maxBytes: 80});
  const compute = text => text;
  cache.render('old', compute);
  cache.render('recent', compute);
  cache.render('old', compute);
  cache.render('new', compute);
  assert.ok(cache.entries.has('old'));
  assert.ok(!cache.entries.has('recent'));
  for (let n = 0; n < 500; n++) {
    cache.render('reply-' + n, compute);
    assert.ok(cache.entries.size <= 2 && cache.bytes <= 80);
  }
  const before = cache.bytes;
  cache.render('x'.repeat(100), compute);
  assert.equal(cache.bytes, before);
  assert.ok(!cache.entries.has('x'.repeat(100)));
  const byteLimited = new TextRenderCache({maxEntries: 100, maxBytes: 40});
  for (let n = 0; n < 100; n++) byteLimited.render('reply-' + n, compute);
  assert.equal(byteLimited.entries.size, 1);
  assert.equal(byteLimited.bytes, 4 * 'reply-99'.length);
});
