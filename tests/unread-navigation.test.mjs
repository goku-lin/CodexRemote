import test from 'node:test';
import assert from 'node:assert/strict';
import {unreadSessions,nextUnreadSession,pendingSessions,nextPendingSession} from '../public/unread-navigation.js';
import {canMarkSessionRead} from '../public/session-status.js';

const sessions=[
  {id:'a',deviceId:'local',projectId:'first',status:'done',unread:true,updatedAt:10},
  {id:'b',deviceId:'local',projectId:'second',status:'failed',unread:true,updatedAt:9},
  {id:'c',deviceId:'local',projectId:'first',status:'interrupted',unread:true,updatedAt:8},
  {id:'active',deviceId:'local',status:'running',unread:true,updatedAt:20},
  {id:'hidden',deviceId:'local',status:'done',unread:true,hidden:true},
  {id:'archived',deviceId:'local',status:'done',unread:true,archived:true},
  {id:'other',deviceId:'other',status:'done',unread:true,updatedAt:30}
];
test('next unread spans projects, skips the current chat, and excludes hidden, archived, active, or other-device chats',()=>{
  assert.deepEqual(unreadSessions(sessions,'local').map(item=>item.id),['a','b','c']);
  assert.equal(nextUnreadSession(sessions,{deviceId:'local',activeSessionId:'a'}).id,'b');
  assert.equal(nextUnreadSession(sessions,{deviceId:'local',activeSessionId:'b'}).id,'a');
  assert.equal(nextUnreadSession(sessions,{deviceId:'other'}).id,'other');
  assert.equal(nextUnreadSession([sessions[0]],{deviceId:'local',activeSessionId:'a'}).id,'a');
  assert.equal(nextUnreadSession([],{deviceId:'local'}),null);
});
test('explicit unread navigation can acknowledge a loaded reply from its beginning, while stale, hidden, or loading views remain unread',()=>{
  const session={status:'done',unread:true,completionToken:'reply',source:'imported',historyVersion:'v1',loadedHistoryVersion:'v1'};
  const view={session,hidden:false,focused:true,loading:false,covered:false,atBottom:false,hasContent:true};
  assert.equal(canMarkSessionRead(view),false);
  assert.equal(canMarkSessionRead({...view,requestedRead:true}),true);
  for(const patch of [{loading:true},{covered:true},{hidden:true},{focused:false},{hasContent:false}])assert.equal(canMarkSessionRead({...view,requestedRead:true,...patch}),false);
  assert.equal(canMarkSessionRead({...view,requestedRead:true,session:{...session,loadedHistoryVersion:'older'}}),false);
  assert.equal(canMarkSessionRead({...view,requestedRead:true,session:{...session,status:'running'}}),false);
});
test('acknowledged chats leave the unread queue and newer unread completions remain eligible',()=>{
  const queue=sessions.slice(0,3).map(item=>({...item}));
  const opened=nextUnreadSession(queue,{deviceId:'local'});opened.unread=false;
  assert.equal(nextUnreadSession(queue,{deviceId:'local',activeSessionId:opened.id}).id,'b');
  queue[1].unread=false;queue[2].unread=false;assert.equal(nextUnreadSession(queue,{deviceId:'local'}),null);
  queue[0].unread=true;queue[0].completionToken='new-reply';assert.equal(nextUnreadSession(queue,{deviceId:'local'}).completionToken,'new-reply');
});

test('handling continues after the current reply becomes read instead of jumping back to an earlier unanswered question',()=>{
  const queue=[{id:'ask',deviceId:'local',status:'waiting_input',updatedAt:3},
    {id:'read-now',deviceId:'local',status:'done',unread:false,updatedAt:2},
    {id:'next-ask',deviceId:'local',status:'running',pendingAttention:[{id:'q',kind:'question'}],updatedAt:1}];
  assert.equal(pendingSessions(queue,'local').length,2);
  assert.equal(nextPendingSession(queue,{deviceId:'local',activeSessionId:'read-now'}).id,'next-ask');
  assert.equal(nextPendingSession(queue,{deviceId:'local',activeSessionId:'next-ask'}).id,'ask');
});
