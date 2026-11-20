import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bbFloorDef, parseRepo, seatThreads, tellCommand, threadStatus, workerInfo, type BbThread } from '../src/server/bbmirror.js';

const DAY = 24 * 60 * 60 * 1000;

function thread(id: string, extra: Partial<BbThread> = {}): BbThread {
  return { id, projectId: 'p', ...extra };
}

test('a thread needing you beats a busy one beats a recent one; a quiet one gets no desk', () => {
  const now = 1_000_000_000_000;
  const threads = [
    thread('quiet'),
    thread('busy', { status: 'active' }),
    thread('waiting', { hasPendingInteraction: true }),
    thread('old', { updatedAt: now - 8 * DAY }),
    thread('recent', { updatedAt: now - 3_600_000 }),
  ];
  const seats = seatThreads(threads, ['a', 'b', 'c', 'd'], now);
  assert.deepEqual([...seats.keys()], ['waiting', 'busy', 'recent']);
});

test('threads keep their desks whoever else arrives', () => {
  const threads = [thread('x', { status: 'active' }), thread('y', { status: 'active' })];
  const first = seatThreads(threads, ['a', 'b', 'c']);
  const again = seatThreads([...threads].reverse(), ['a', 'b', 'c']);
  assert.deepEqual(again, first);
});

test('more threads than desks: the desks fill with the ones that matter most', () => {
  const threads = [1, 2, 3, 4].map((n) => thread(`t${n}`, { hasPendingInteraction: n === 1, status: 'active' }));
  const seats = seatThreads(threads, ['a', 'b']);
  assert.equal(seats.size, 2);
  assert.ok(seats.has('t1'));
});

test('a thread\'s status, as the office says it at a desk', () => {
  assert.equal(threadStatus(thread('a', { hasPendingInteraction: true })), 'needs_input');
  assert.equal(threadStatus(thread('a', { status: 'active' })), 'working');
  assert.equal(threadStatus(thread('a', { status: 'pending' })), 'starting');
  assert.equal(threadStatus(thread('a', { status: 'error' })), 'exited');
  assert.equal(threadStatus(thread('a')), 'idle');
});

test('repos parse out of git remotes', () => {
  assert.equal(parseRepo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(parseRepo('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(parseRepo('https://gitlab.com/owner/repo'), undefined);
});

test('talking to a thread is one bb command, steering a live turn or starting one', () => {
  assert.deepEqual(tellCommand('thr_1', 'ship it'), ['thread', 'tell', 'thr_1', '--mode', 'auto', 'ship it']);
});
test('a thread becomes a worker with its provider and title', () => {
  const w = workerInfo(thread('thr_1', { providerId: 'claude-code', title: 'Fix the thing', status: 'active' }), 'desk-1', 'Mochi');
  assert.equal(w.provider, 'claude');
  assert.equal(w.status, 'working');
  assert.equal(w.task.name, 'Fix the thing');
  assert.equal(w.createdBy, 'bb');
  assert.ok(w.acked);
  assert.ok(!workerInfo(thread('thr_2', { hasPendingInteraction: true }), 'desk-2', 'Pip').acked);
});

test('a BB floor keeps its writable state out of the project it shows', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-office-bb-'));
  try {
    const def = bbFloorDef({ dataDir: home }, { id: 'p1', name: 'proj', sources: [{ type: 'local_path', path: path.join(home, 'gone'), isDefault: true }] });
    assert.equal(def.id, 'bb-p1');
    assert.equal(def.name, 'proj');
    assert.equal(def.dataDir, path.join(home, 'bb', 'p1'));
    assert.equal(def.dir, path.join(home, 'bb', 'p1', 'src'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
