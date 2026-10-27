import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {usagePeriod,normalizeUsageRange,usageRangeKey} from '../public/usage-range.js';

test('usage presets cover local whole days, with month and week including today',()=>{
  const now=new Date(2026,9,15,18,30);
  const month=usagePeriod('month','','',now),week=usagePeriod('week','','',now),today=usagePeriod('today','','',now);
  assert.equal(month.fromDate,'2026-09-16');assert.equal(month.toDate,'2026-10-15');
  assert.equal(week.fromDate,'2026-10-09');assert.equal(today.fromDate,'2026-10-15');
  assert.equal(today.range.from,new Date(2026,9,15).getTime());assert.equal(today.range.to,new Date(2026,9,16).getTime());
  assert.equal(usagePeriod('all').range,null);
  assert.deepEqual(usagePeriod('custom','2026-10-15','2026-10-15').range,today.range);
  assert.notEqual(usageRangeKey('local',week.range),usageRangeKey('local',month.range));
});

test('custom dates reject incomplete, reversed and impossible dates',()=>{
  for(const [from,to] of [['','2026-10-15'],['2026-10-16','2026-10-15'],['2026-02-30','2026-03-01'],['2026-2-01','2026-03-01']])assert.throws(()=>usagePeriod('custom',from,to));
  for(const range of [{from:1,to:1},{from:-1,to:2},{from:NaN,to:2},{from:1,to:Infinity},{from:'1',to:2}])assert.throws(()=>normalizeUsageRange(range));
});

test('custom days retain inclusive end dates across daylight saving changes',()=>{
  const moduleUrl=new URL('../public/usage-range.js',import.meta.url).href;
  const script=`import {usagePeriod} from ${JSON.stringify(moduleUrl)};for(const date of ['2026-03-08','2026-11-01']){const {range}=usagePeriod('custom',date,date);console.log((range.to-range.from)/3600000);}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,env:{...process.env,TZ:'America/New_York'}});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(Number),[23,25]);
});
