import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {HistorySync} from '../src/history-sync.mjs';
import {applyHistoryUpdate} from '../public/history-sync.js';

const event = (id, text, turnId = 'turn') => ({type:'user_message', id, text, turnId, at:1});
const history = events => ({sessionId:'one', historyLoaded:true, historyVersion:'v1', turns:[], turnCount:1, messageCount:events.length, events});

test('changed records update atomically while unchanged rows are retained and bandwidth falls', () => {
  const sync = new HistorySync();
  const events = Array.from({length:100},(_,i)=>event(String(i),('Old output '+i+' 中文😀 ').repeat(500)));
  const full = sync.response(history(events), '5');
  const previous = applyHistoryUpdate({},full);
  const next = {...history([...events.slice(0,-1),event('99','New text')]),historyVersion:'v2'};
  const delta = sync.response(next,'5',previous.cursor);
  assert.equal(delta.historySync.kind,'delta');
  assert.equal(delta.events.length,1);
  assert.deepEqual(applyHistoryUpdate(previous,delta).events,next.events);
  assert.strictEqual(applyHistoryUpdate(previous,delta).events[0],events[0]);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(full))/20);
  assert.ok(gzipSync(JSON.stringify(delta)).length < gzipSync(JSON.stringify(full)).length/5);
  const unchanged = sync.response(next,'5',delta.historySync.cursor);
  assert.equal(unchanged.events.length,0);
  assert.equal(unchanged.historySync.cursor,delta.historySync.cursor);
});

test('sliding history windows, rollback, reordering and duplicate raw identities reproduce the exact snapshot', () => {
  const sync = new HistorySync();
  const before = history([event('old','Older'),event('same','first'),event('same','second'),event('new','Newest')]);
  let previous = applyHistoryUpdate({},sync.response(before,'5'));
  for(const events of [before.events.slice(1),[before.events[3],before.events[1]],[],[event('restored','Restored')]]){
    const result=sync.response(history(events),'5',previous.cursor);
    previous=applyHistoryUpdate(previous,result);
    assert.deepEqual(previous.events,events);
    assert.equal(new Set(previous.keys).size,events.length);
  }
});

test('cursors are scoped to their conversation and window and safely recover after eviction or restart', () => {
  const sync = new HistorySync({maxEntries:1,maxBytes:2048});
  const value=history([event('one','Content')]),full=sync.response(value,'5');
  assert.equal(sync.response({...value,sessionId:'two'},'5',full.historySync.cursor).historySync.kind,'full');
  assert.equal(sync.response(value,'all',full.historySync.cursor).historySync.kind,'full');
  assert.equal(sync.response(value,'5',full.historySync.cursor).historySync.kind,'full');
  assert.equal(new HistorySync().response(value,'5',full.historySync.cursor).historySync.kind,'full');
  assert.ok(sync.stats().entries<=1);assert.ok(sync.stats().bytes<=2048);
  const tiny = new HistorySync({maxBytes:1});tiny.response(value,'5');assert.equal(tiny.stats().entries,0);
});

test('a broken delta never mutates the cached history and legacy servers remain compatible', () => {
  const sync=new HistorySync(),value=history([event('one','Original')]);
  const full=sync.response(value,'5'),previous=applyHistoryUpdate({},full);
  const bad={...value,events:[],historySync:{kind:'delta',baseCursor:previous.cursor,cursor:'new',keys:[],order:['missing']}};
  assert.throws(()=>applyHistoryUpdate(previous,bad),/缺少/);
  assert.throws(()=>applyHistoryUpdate({...previous,cursor:'different'},bad),/过期/);
  assert.equal(previous.events[0].text,'Original');
  assert.deepEqual(applyHistoryUpdate(previous,value),{events:value.events,keys:null,cursor:null});
});
