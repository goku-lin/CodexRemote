export const appIconThemes=[
  {id:'desktop',name:'台式机 · 蓝色',color:'#78aafa',badge:'台'},
  {id:'laptop',name:'笔记本 · 紫色',color:'#c3a1f4',badge:'笔'},
  {id:'home',name:'家里 · 绿色',color:'#62ddb0',badge:'家'},
  {id:'office',name:'办公室 · 橙色',color:'#ffbd78',badge:'办'},
  {id:'one',name:'设备 1 · 粉色',color:'#ed98ba',badge:'1'},
  {id:'two',name:'设备 2 · 青色',color:'#72d5df',badge:'2'}
];
export function appIconTheme(value='auto'){
  if(value!=='auto'&&!appIconThemes.some(theme=>theme.id===value))throw new Error('请选择有效的桌面图标样式。');return value;
}
export function resolveAppIcon(name,choice='auto',machine=''){
  appIconTheme(choice);let id=choice;
  if(id==='auto'){
    const infer=value=>/笔记本|便携|laptop|notebook/i.test(value)?'laptop':/台式|desktop|工作站/i.test(value)?'desktop':/办公室|office/i.test(value)?'office':/家里|home/i.test(value)?'home':null;
    id=infer(String(name||''))||infer(machine)||'desktop';
  }
  return appIconThemes.find(theme=>theme.id===id);
}
