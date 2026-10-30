import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleSteps, placeCard } from './tour.js';

test('steps are filtered by their when() condition', () => {
  const steps = [{ id: 'a' }, { id: 'b', when: ctx => ctx.cluster }, { id: 'c', when: () => false }];
  assert.deepEqual(visibleSteps(steps, { cluster: false }).map(step => step.id), ['a']);
  assert.deepEqual(visibleSteps(steps, { cluster: true }).map(step => step.id), ['a', 'b']);
  assert.deepEqual(visibleSteps(steps).map(step => step.id), ['a']);
});

const viewport = { width: 1000, height: 700 };
const card = { width: 300, height: 140 };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test('the card goes on the preferred side when it fits', () => {
  const placed = placeCard(rect(100, 100, 200, 40), card, viewport, 'bottom');
  assert.equal(placed.placement, 'bottom');
  assert.equal(placed.top, 152);
});

test('placement flips when the preferred side would overflow the viewport', () => {
  assert.equal(placeCard(rect(100, 600, 200, 40), card, viewport, 'bottom').placement, 'top');
  assert.equal(placeCard(rect(900, 300, 90, 40), card, viewport, 'right').placement, 'left');
});

test('the card stays inside the viewport and is centred without a target', () => {
  const edge = placeCard(rect(0, 0, 40, 40), card, viewport, 'top');
  assert.ok(edge.left >= 8 && edge.top >= 8);
  assert.deepEqual(placeCard(null, card, viewport), { top: 280, left: 350, placement: 'center' });
});
