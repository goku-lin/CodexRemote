import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectOrder} from '../public/project-order.js';

const projects=['a','b','c'].map(id=>({id,name:id}));
const ids=items=>items.map(item=>item.id);
function memory(){const values=new Map();return {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};}

test('project positions remain stable when activity changes, a new project arrives, and the page reloads',()=>{
  const storage=memory(),order=new ProjectOrder(storage);
  assert.deepEqual(ids(order.arrange(projects)),['a','b','c']);
  assert.deepEqual(ids(order.arrange(projects.slice().reverse())),['a','b','c']);
  assert.deepEqual(ids(order.arrange([{id:'new'},...projects.slice().reverse()])),['a','b','c','new']);
  const restored=new ProjectOrder(storage);
  assert.deepEqual(ids(restored.arrange([{id:'new'},...projects])),['a','b','c','new']);
});

test('moving to an exact position persists without changing other devices or the supplied project list',()=>{
  const storage=memory(),order=new ProjectOrder(storage);
  order.arrange(projects,'local');order.arrange(projects.slice().reverse(),'other');
  assert.equal(order.move(projects,'c',0,'local'),true);
  assert.deepEqual(ids(order.arrange(projects,'local')),['c','a','b']);
  assert.deepEqual(ids(order.arrange(projects,'other')),['c','b','a']);
  assert.deepEqual(ids(projects),['a','b','c']);
  assert.deepEqual(ids(new ProjectOrder(storage).arrange(projects,'local')),['c','a','b']);
  assert.equal(order.move(projects,'c',2,'local'),true);
  assert.deepEqual(ids(order.arrange(projects,'local')),['a','b','c']);
});

test('hiding and restoring a project keeps its slot even when visible projects are moved',()=>{
  const order=new ProjectOrder(memory());order.arrange(projects);
  const visible=[projects[0],projects[2]];
  assert.equal(order.move(visible,'c',0),true);
  assert.deepEqual(ids(order.arrange(visible)),['c','a']);
  assert.deepEqual(ids(order.arrange(projects)),['c','b','a']);
  order.arrange([]);assert.deepEqual(ids(order.arrange(projects)),['c','b','a']);
});

test('storage errors and invalid moves keep the current order usable without unnecessary writes',()=>{
  let writes=0;
  const order=new ProjectOrder({getItem:()=>'{broken',setItem:()=>{writes++;throw new Error('Storage denied');}});
  order.arrange(projects);assert.equal(writes,1);
  for(const target of [-1,3,1.5,NaN])assert.equal(order.move(projects,'a',target),false);
  assert.equal(order.move(projects,'missing',0),false);assert.equal(order.move(projects,'a',0),false);
  assert.deepEqual(ids(order.arrange(projects.slice().reverse())),['a','b','c']);assert.equal(writes,1);
  assert.equal(order.move(projects,'a',2),true);assert.deepEqual(ids(order.arrange(projects)),['b','c','a']);
});
