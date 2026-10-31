import test from 'node:test';
import assert from 'node:assert/strict';
import { podOf, parseFilter, passes, createPodColors, splitLines, renderLines, podsStatus, containersOfPods } from './logs-util.js';

test('the pod prefix is parsed, other lines have none', () => {
  assert.deepEqual(podOf('[web-1/app] GET /healthz 200\n'), { pod: 'web-1', container: 'app', prefix: 11 });
  assert.equal(podOf('[web-1/app] x'.slice(0, 5)), null);
  assert.equal(podOf('plain line'), null);
  assert.equal(podOf('[rubban] Following the first 20 containers'), null);
  assert.equal(podOf('[a b/c] no spaces in names'), null);
  assert.equal(podOf('2026-01-01T00:00:00Z [web-1/app] later in the line'), null);
});

test('filters: substring is case-insensitive, /regex/ is a regular expression, invalid ones report an error', () => {
  assert.equal(parseFilter('   '), null);
  assert.equal(parseFilter('Health').test('GET /healthz'), true);
  assert.equal(parseFilter('health').test('GET /metrics'), false);
  const re = parseFilter('/^\\[web-\\d\\] .*(ERROR|WARN)/');
  assert.equal(re.test('[web-1] x ERROR boom'), true);
  assert.equal(re.test('[db-1] x ERROR boom'), false);
  assert.equal(parseFilter('/error/i').test('an ERROR'), true);
  assert.equal(parseFilter('/error/g').test('error'), true, 'g and y flags are dropped so test() has no state');
  assert.equal(parseFilter('/error/g').test('error') && parseFilter('/(/').error !== undefined, true);
  assert.match(parseFilter('/(/').error, /./);
  assert.equal(parseFilter('a/b').test('xa/bx'), true, 'a slash inside plain text is plain text');
});

test('include and exclude combine; an exclude wins; broken filters are ignored', () => {
  const line = '[web-1/app] GET /healthz 200\n';
  assert.equal(passes(line, {}), true);
  assert.equal(passes(line, { include: parseFilter('get') }), true);
  assert.equal(passes(line, { include: parseFilter('post') }), false);
  assert.equal(passes(line, { exclude: parseFilter('healthz') }), false);
  assert.equal(passes(line, { include: parseFilter('get'), exclude: parseFilter('healthz') }), false);
  assert.equal(passes(line, { include: parseFilter('/(/'), exclude: parseFilter('/(/') }), true);
});

test('lines of a hidden pod are dropped, lines without a prefix never are', () => {
  const hidden = new Set(['web-2']);
  assert.equal(passes('[web-2/app] x\n', { hidden }), false);
  assert.equal(passes('[web-1/app] x\n', { hidden }), true);
  assert.equal(passes('[rubban] note\n', { hidden }), true);
});

test('colours are handed out in order and stay with their pod', () => {
  const colors = createPodColors(3);
  assert.deepEqual(['a', 'b', 'c', 'd', 'a', 'c'].map(pod => colors.indexOf(pod)), [0, 1, 2, 0, 0, 2]);
  assert.deepEqual(colors.known(), ['a', 'b', 'c', 'd']);
  assert.equal(createPodColors().indexOf('x'), 0);
});

test('chunks are split into whole lines, the unfinished rest is carried', () => {
  let state = splitLines('', 'one\ntwo\nthr');
  assert.deepEqual(state, { lines: ['one\n', 'two\n'], rest: 'thr' });
  state = splitLines(state.rest, 'ee\nfour');
  assert.deepEqual(state, { lines: ['three\n'], rest: 'four' });
  assert.deepEqual(splitLines('', 'no newline'), { lines: [], rest: 'no newline' });
  assert.deepEqual(splitLines('', '\n\n'), { lines: ['\n', '\n'], rest: '' });
});

test('rendering keeps the lines that pass and marks the pod prefixes by offset', () => {
  const lines = ['[web-1/app] a\n', '[web-2/app] healthz\n', 'plain\n', '[web-1/app] b\n'];
  const { text, marks } = renderLines(lines, { exclude: parseFilter('healthz') });
  assert.equal(text, '[web-1/app] a\nplain\n[web-1/app] b\n');
  assert.deepEqual(marks, [{ pod: 'web-1', start: 0, end: 11 }, { pod: 'web-1', start: 20, end: 31 }]);
  assert.equal(text.slice(marks[1].start, marks[1].end), '[web-1/app]');
});

test('status line and container list from the pods the server reported', () => {
  assert.equal(podsStatus([]), 'Waiting for pods…');
  assert.equal(podsStatus(undefined), 'Waiting for pods…');
  assert.equal(podsStatus([{ phase: 'Running' }, { phase: 'Running' }, { phase: 'Running' }]), '3 pods');
  assert.equal(podsStatus([{ phase: 'Running' }]), '1 pod');
  assert.equal(podsStatus([{ phase: 'Running' }, { phase: 'Pending' }]), '2 pods · 1 running');
  assert.deepEqual(containersOfPods([{ containers: ['app', 'sidecar'] }, { containers: ['app'] }, {}]), ['app', 'sidecar']);
});
