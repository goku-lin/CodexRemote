import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectOrder} from '../public/project-order.js';
import {ProjectManagement} from '../public/project-management.js';

const projects=[{id:'a',deviceId:'local'},{id:'b',deviceId:'local',hidden:true},{id:'c',deviceId:'local'},{id:'other',deviceId:'remote',hidden:true}];
test('project order and visibility remain drafts until Save, including previously hidden projects',()=>{
  const order=new ProjectOrder();order.arrange(projects.slice(0,3));
  const draft=new ProjectManagement(projects,order,'local');
  assert.deepEqual(draft.rows().map(item=>item.id),['a','b','c']);
  draft.setEnabled('b',true);draft.setEnabled('a',false);draft.move('c',0);
  assert.deepEqual(draft.hiddenProjects(),['a','other']);
  assert.deepEqual(order.arrange(projects.slice(0,3)).map(item=>item.id),['a','b','c']);
  const canceled=new ProjectManagement(projects,order,'local');assert.deepEqual(canceled.hiddenProjects(),['b','other']);
  draft.commit(order);assert.deepEqual(order.arrange(projects.slice(0,3)).map(item=>item.id),['c','a','b']);
  assert.equal(projects[1].hidden,true,'the server catalog is not mutated by the editor');
});
