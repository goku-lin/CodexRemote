export function normalizeUsageRange(value) {
  if(!value || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)
    || value.from<0 || value.to<=value.from || value.to>8640000000000000)throw new Error('统计时间范围无效。');
  return {from:value.from,to:value.to};
}

export function localUsageDate(date=new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function parseDate(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value || ''))throw new Error('请选择开始和结束日期。');
  const [year,month,day]=value.split('-').map(Number),date=new Date(year,month-1,day);
  if(year<1971 || localUsageDate(date)!==value)throw new Error('请选择有效日期。');
  return date;
}

export function usagePeriod(preset='month',start='',end='',now=new Date()) {
  if(preset==='all')return {range:null,label:'全部历史'};
  const until=new Date(now);until.setHours(0,0,0,0);
  let since=new Date(until);
  if(preset==='custom') {
    since=parseDate(start);until.setTime(parseDate(end).getTime());
    if(since>until)throw new Error('开始日期不能晚于结束日期。');
  }else if(preset==='month')since.setDate(since.getDate()-29);
  else if(preset==='week')since.setDate(since.getDate()-6);
  else if(preset!=='today')throw new Error('请选择统计时间范围。');
  const fromDate=localUsageDate(since),toDate=localUsageDate(until);
  // Local calendar arithmetic keeps whole days correct across DST changes.
  until.setDate(until.getDate()+1);
  return {range:normalizeUsageRange({from:since.getTime(),to:until.getTime()}),fromDate,toDate,
    label:`${fromDate} 至 ${toDate}`};
}

export function usageRangeKey(deviceId,range) {return JSON.stringify([deviceId,range?.from,range?.to]);}
