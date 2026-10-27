import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineViewport } from '../public/timeline-scroll.js';

function fixture() {
  const messages = { scrollTop: 0, height: 2000, bottomSpace: 0, clientHeight: 400, nodes: [],
    get scrollHeight() { return this.height + this.bottomSpace; },
    getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    querySelectorAll(selector) { return selector.includes('data-message-id') ? this.nodes.filter(node => node.dataset.messageId) : this.nodes; } };
  messages.style = { setProperty: (_name, value) => { messages.bottomSpace = Number.parseFloat(value); } };
  const node = (id, offset) => ({ dataset: { messageId: id }, offset, isConnected: true,
    getBoundingClientRect() { return { top: 100 + this.offset - messages.scrollTop, bottom: 160 + this.offset - messages.scrollTop }; } });
  messages.nodes = [node('first', 600)];
  const viewport = new TimelineViewport();
  viewport.restore(messages, viewport.capture(messages, 'a', 'first'));
  return { messages, viewport, node };
}

test('one new input is aligned at the top; subsequent output never follows the bottom', () => {
  const { messages, viewport } = fixture();
  assert.equal(messages.scrollTop, 584);
  messages.scrollTop = 1600; // The reader is at the current bottom.
  const snapshot = viewport.capture(messages, 'a', 'first');
  messages.height += 500;
  viewport.restore(messages, snapshot);
  assert.equal(messages.scrollTop, 1600);
});

test('inserting content above the reader preserves the visible message position', () => {
  const { messages, viewport } = fixture();
  messages.scrollTop = 620;
  const before = messages.nodes[0].getBoundingClientRect().top;
  const snapshot = viewport.capture(messages, 'a', 'first');
  messages.nodes[0].offset += 250;
  viewport.restore(messages, snapshot);
  assert.equal(messages.nodes[0].getBoundingClientRect().top, before);
});

test('a later user input positions once, then respects manual scrolling', () => {
  const { messages, viewport, node } = fixture();
  const snapshot = viewport.capture(messages, 'a', 'second');
  messages.nodes.push(node('second', 1800));
  viewport.restore(messages, snapshot);
  assert.equal(messages.scrollTop, 1784);
  messages.scrollTop = 1200;
  viewport.restore(messages, viewport.capture(messages, 'a', 'second'));
  assert.equal(messages.scrollTop, 1200);
});

test('returning to a conversation restores its reading position', () => {
  const { messages, viewport, node } = fixture();
  messages.scrollTop = 700;
  let snapshot = viewport.capture(messages, 'b', 'other');
  messages.nodes = [node('other', 1000)];
  viewport.restore(messages, snapshot);
  snapshot = viewport.capture(messages, 'a', 'first');
  messages.nodes = [node('first', 600)];
  viewport.restore(messages, snapshot);
  assert.equal(messages.scrollTop, 700);
});

test('an input not yet rendered keeps its positioning request until it becomes visible', () => {
  const { messages, viewport, node } = fixture();
  viewport.restore(messages, viewport.capture(messages, 'a', 'second'));
  const snapshot = viewport.capture(messages, 'a', 'second');
  messages.nodes.push(node('second', 1800));
  viewport.restore(messages, snapshot);
  assert.equal(messages.scrollTop, 1784);
});
