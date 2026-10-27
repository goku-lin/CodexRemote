import test from 'node:test';
import assert from 'node:assert/strict';
import {searchSessions,sessionSearchActive} from '../public/session-search.js';

const sessions=[
  {id:'run',deviceId:'local',title:'处理登录',cwd:'D:/工作/GPT Project',status:'running',unread:true,updatedAt:5},
  {id:'input',deviceId:'local',title:'等待确认',projectName:'第二项目',status:'waiting_input',updatedAt:4},
  {id:'approval',deviceId:'local',title:'等待审批',status:'waiting_approval',updatedAt:3},
  {id:'done',deviceId:'local',title:'修复登录',projectName:'GPT Project',status:'done',unread:true,updatedAt:2},
  {id:'failed',deviceId:'local',title:'失败任务',status:'failed',unread:true,createdAt:1},
  {id:'sync',deviceId:'local',title:'旧任务',status:'synced',unread:true},
  {id:'hidden',deviceId:'local',title:'隐藏任务',status:'running',hidden:true},
  {id:'archived',deviceId:'local',title:'归档任务',status:'running',archived:true},
  {id:'other',deviceId:'other',title:'处理登录',status:'running'}
];

test('title/project/path search is case-insensitive, matches mixed words, and normalizes full-width text',()=>{
  assert.deepEqual(searchSessions(sessions,{query:'  ＧＰＴ　登录 ',deviceId:'local'}).map(item=>item.id),['run','done']);
  assert.deepEqual(searchSessions(sessions,{query:'第二 项目',deviceId:'local'}).map(item=>item.id),['input']);
  assert.deepEqual(searchSessions(sessions,{query:'工作 登录',deviceId:'local'}).map(item=>item.id),['run']);
  assert.equal(searchSessions(sessions,{query:'[.*]',deviceId:'local'}).length,0);
  assert.ok(!sessionSearchActive(' \t　\n','all'));assert.ok(sessionSearchActive('','waiting'));
});

test('status filters distinguish active work, completed unread replies and questions/approvals',()=>{
  const ids=filter=>searchSessions(sessions,{filter,deviceId:'local'}).map(item=>item.id);
  assert.deepEqual(ids('running'),['run','input','approval']);
  assert.deepEqual(ids('unread'),['done','failed']);
  assert.deepEqual(ids('waiting'),['input','approval','done','failed']);
  assert.deepEqual(searchSessions(sessions,{query:'登录',filter:'unread',deviceId:'local'}).map(item=>item.id),['done']);
});

test('hidden, archived and other-device sessions remain excluded; searching never changes original order',()=>{
  const original=[...sessions];
  assert.equal(searchSessions(sessions,{deviceId:'local'}).length,6);
  assert.deepEqual(sessions,original);
  assert.deepEqual(searchSessions(sessions,{deviceId:'other'}).map(item=>item.id),['other']);
});
