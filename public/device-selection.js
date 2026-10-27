export function deviceSession(sessions,deviceId,rememberedId){
  const own=sessions.filter(session=>session.deviceId===deviceId);
  return own.find(session=>session.id===rememberedId) || own.slice().sort((a,b)=>(b.updatedAt || b.createdAt || 0)-(a.updatedAt || a.createdAt || 0))[0] || null;
}
