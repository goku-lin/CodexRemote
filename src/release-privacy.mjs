// Check filenames only. Never include credential values in a packaging error.
export function assertPublicFiles(names){
  for(const name of names){
    const normalized=String(name).replaceAll('\\','/');
    if(/(?:^|\/)(?:\.git|\.codex|\.claude|\.dsh|\.relay-data|\.manager-backups|accounts|state|\.env(?:\..*)?|auth(?:\.[^/]*)?\.json|account-desktop-entry\.ps1|Cookies|cookies\.sqlite)(?:\/|$)/i.test(normalized)
      || /(?:^|\/)\.credentials\.yaml$/i.test(normalized)
      || /\.(?:key|pem|pfx|p12|dpapi|bak)$/i.test(normalized))throw new Error('发布包包含本机私有文件，已停止打包。');
  }
}
