import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bbFloorDef, parseRepo, seatThreads, eventLine, tellCommand, threadStatus, workerInfo, ackedFor, MirrorSession, runBb, __testBb, type BbThread } from '../src/server/bbmirror.js';

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
  assert.deepEqual(tellCommand('thr_1', 'ship it'), ['thread', 'tell', 'thr_1', '--mode', 'auto', '--', 'ship it']);
});

test('runBb answers with what bb printed, and --json stays ahead of the message', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-stub-'));
  const stub = `#!/bin/sh\n# a stand-in bb: remembers its flags, answers in JSON\necho "$@" > "$BB_STUB_ARGS"\necho '[{"ok": true}]'\n`;
  writeFileSync(path.join(dir, 'bb'), stub, { mode: 0o755 });
  const argsFile = path.join(dir, 'args.txt');
  process.env.BB_STUB_ARGS = argsFile;
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const answer = await runBb<{ ok: boolean }[]>('thread', 'tell', 'thr_1', '--', 'ship it');
    assert.deepEqual(answer, [{ ok: true }]);
    assert.equal(readFileSync(argsFile, 'utf8').trim(), 'thread tell thr_1 --json -- ship it');
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log says what happened, and plumbing stays out of the terminal', () => {
  const at = (type: string, data: unknown) => eventLine({ seq: 1, createdAt: 0, type, data });
  assert.equal(at('client/turn/requested', { input: [{ type: 'text', text: 'ship it' }] })?.includes('ship it'), true);
  assert.equal(at('item/completed', { item: { type: 'agentMessage', text: 'done, PR open' } })?.includes('done, PR open'), true);
  assert.equal(at('item/completed', { item: { type: 'commandExecution', command: 'npm test', exitCode: 0 } })?.includes('npm test'), true);
  assert.equal(at('item/reasoning/textDelta', { text: 'hmm' }), undefined);
  assert.equal(at('thread/tokenUsage/updated', {}), undefined);
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

test('a tell is one argument after --: a message that looks like options stays a message', () => {
  assert.deepEqual(tellCommand('thr_1', '--file=pwn --json hi'), ['thread', 'tell', 'thr_1', '--mode', 'auto', '--', '--file=pwn --json hi']);
});

test('only the start of a wait rings the beacon again', () => {
  assert.equal(ackedFor('working', false), true);
  assert.equal(ackedFor('needs_input', false), false); // it just started waiting
  assert.equal(ackedFor('needs_input', true), false); // nobody has acked yet
  assert.equal(ackedFor('needs_input', true, true), true); // acked, and it stays acked while it waits
});

test('what a thread says never reaches the terminal as escape codes', () => {
  const line = eventLine({
    seq: 1,
    createdAt: 0,
    type: 'item/completed',
    data: { item: { type: 'agentMessage', text: 'x\x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\ and \x07 bells' } },
  });
  assert.ok(line);
  assert.ok(!line.includes('\x1b]8'));
  assert.ok(!line.includes('\x07'));
});

test('a watched session shows the tail, sends tells intact, and goes quiet once its worker is gone', async () => {
  const calls: string[][] = [];
  let pages = 0;
  __testBb(async (...args) => {
    calls.push(args);
    if (args[1] === 'tell') return { ok: true };
    return pages++ === 0 ? Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, createdAt: 0, type: 'turn/completed', data: { status: 'ok' } })) : [];
  });
  const lines: string[] = [];
  let watching = false;
  const s = new MirrorSession('thr_1', (l) => lines.push(l), () => watching);
  try {
    watching = true;
    s.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines.length, 12); // a short thread shows whole
    assert.ok(calls[0].includes('--limit')); // the tail in one big page, not twenty-five small ones

    s.prompt('hello --file=pwn');
    await new Promise((r) => setTimeout(r, 20));
    const tell = calls.find((a) => a[1] === 'tell')!;
    assert.equal(tell[tell.indexOf('--') + 1], 'hello --file=pwn'); // the message, verbatim
    assert.ok(tell.indexOf('--json') < tell.indexOf('--')); // options never land inside it

    s.close();
    pages = 99;
    s.tick(); // a stale view must not restart a dead session
    s.prompt('nope');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!calls.some((a) => a.includes('nope')));
  } finally {
    s.close();
    __testBb(undefined);
  }
});
