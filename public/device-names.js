export function deviceName(value) {
  if(typeof value!=='string' || !value.trim() || value.length>80 || /[\u0000-\u001f\u007f]/.test(value))throw new Error('电脑名称需要 1–80 个字符，不能包含换行或控制字符。');
  return value.trim();
}
