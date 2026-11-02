import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDesktopProjects} from '../src/desktop-projects.mjs';

test('Desktop membership unites moved and multi-root chats without rewriting historical cwd',()=>{
  const state={'local-projects':{game:{id:'game',name:'Game',rootPaths:['E:\\Game','E:\\Art']},art:{id:'art',name:'Art',rootPaths:['E:\\Art']}},'thread-project-assignments':{old:{projectKind:'local',projectId:'game'},art:{projectKind:'local',projectId:'art'},multi:{projectKind:'local',projectId:'game'}}};
  const threads=[{id:'old',cwd:'D:\\Game'},{id:'new',cwd:'E:\\Game'},{id:'art',cwd:'D:\\Art'},{id:'multi',cwd:'E:\\Art'},{id:'ambiguous',cwd:'E:\\Art'},{id:'unrelated',cwd:'F:\\Game'}];
  const result=attachDesktopProjects(threads,state);
  assert.deepEqual(result[0].relayProject,result[1].relayProject);
  assert.equal(result[0].cwd,'D:\\Game');assert.equal(result[0].relayProject.cwd,'E:\\Game');
  assert.equal(result[2].relayProject.id,'art');assert.equal(result[3].relayProject.id,'game');
  assert.equal(result[4].relayProject,undefined);assert.equal(result[5].relayProject,undefined);
  assert.equal(threads[0].relayProject,undefined);
  state['local-projects'].game.rootPaths=['F:\\Game'];
  assert.equal(attachDesktopProjects(threads,state)[0].relayProject.id,'game');
  assert.equal(attachDesktopProjects(threads,state)[0].relayProject.cwd,'F:\\Game');
});

test('projectless, remote-host and deleted assignments are never guessed from directory names',()=>{
  const state={'local-projects':{game:{id:'game',name:'Game',rootPaths:['E:\\Game']}},'thread-project-assignments':{deleted:{projectKind:'local',projectId:'missing'}},'thread-project-membership-host-ids':{remote:'another-host'},'projectless-thread-ids':['none']};
  const threads=['none','remote','deleted'].map(id=>({id,cwd:'E:\\Game'}));
  assert.deepEqual(attachDesktopProjects(threads,state),threads);
});
