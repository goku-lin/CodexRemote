import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPublicFiles} from '../src/release-privacy.mjs';
test('release guard rejects local accounts, tokens, passwords, cookies and backups',()=>{
  for(const name of ['accounts/alice.json','app/accounts/login.json','app/.codex/auth.json','app/auth.json','app/auth.backup.json','app/state/password.json','app/.env','app/.env.local','app/browser.key','app/key.dpapi','app/entry.ps1.bak','app/account-desktop-entry.ps1','app/profile/Cookies','app/cookies.sqlite','app\\.relay-data\\token'])assert.throws(()=>assertPublicFiles([name]),/私有文件/);
  assert.doesNotThrow(()=>assertPublicFiles(['release.json','runtime/node.exe','app/account-switcher.mjs','app/account-usage.mjs','app/lan-access.ps1','app/public/index.html']));
});
