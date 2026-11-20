// What BB (the agent manager this machine runs) shows of itself in the building: a floor per BB
// project, a desk per live thread (see docs/bb-mirror.md). BB stays the source of truth — the
// office only reads it, through the bb CLI, and never writes to the projects it shows.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Floor } from './floor.js';
import type { FloorDef } from './building.js';
import { DESKS } from '../shared/layout.js';
import { FLOOR_PALETTES } from '../shared/floors.js';
import type { AgentProvider, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import { COLORS, NAMES } from './workers/worker.js';
import type { WorkerSession } from './workers/session.js';
import type { Worker } from './workers/types.js';
import { truncate } from './workers/util.js';
import type { Ctx } from './office/context.js';

const exec = promisify(execFile);

const FLOOR_MS = 60_000; // projects come and go slowly
const THREAD_MS = 5_000; // desk statuses should feel live
const LOG_MS = 10_000; // a terminal someone is watching refreshes
const MAX_FLOORS = 12; // the elevator only has so many buttons
const RECENT_MS = 7 * 24 * 60 * 60 * 1000; // a thread quiet for a week has gone home
const BB_TIMEOUT_MS = 15_000;

/** What `bb project list --json` says (the fields the office reads). */
export interface BbProject {
  id: string;
  name: string;
  gitRemoteUrl?: string;
  sources?: { type: string; path: string; isDefault?: boolean }[];
}

/** What `bb thread list --json` says (the fields the office reads). */
export interface BbThread {
  id: string;
  projectId: string;
  providerId?: string;
  model?: string;
  title?: string;
  titleFallback?: string;
  status?: string;
  pinnedAt?: number | null;
  updatedAt?: number;
  hasPendingInteraction?: boolean;
}

/** What `bb thread log --json` says, one entry per line (the fields the office reads). */
export interface BbEvent {
  seq: number;
  createdAt: number;
  type: string;
  data?: unknown;
}

/** BB's provider ids as the office knows their icons. */
const PROVIDER_MAP: Record<string, AgentProvider> = { pi: 'pi', codex: 'codex', 'claude-code': 'claude' };

let complainedAt = 0;

/** Runs `bb` and parses its --json answer; undefined (with one note a minute) when BB can't be asked. */
async function runBb<T>(...args: string[]): Promise<T | undefined> {
  try {
    const { stdout } = await exec('bb', [...args, '--json'], { timeout: BB_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  } catch (err) {
    if (Date.now() - complainedAt > 60_000) {
      complainedAt = Date.now();
      console.error(`agent-office: bb ${args.join(' ')} failed: ${(err as Error).message}`);
    }
    return undefined;
  }
}

/** FNV-1a: a thread's stable place in the name list, the palette and at a desk. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 'owner/name' out of a git remote, when it points at one. */
export function parseRepo(url?: string): string | undefined {
  const hit = url?.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i);
  return hit ? `${hit[1]}/${hit[2]}` : undefined;
}

/** One BB project as a floor of the building. */
export function bbFloorDef(cfg: { dataDir: string }, p: BbProject): FloorDef {
  const source = p.sources?.find((s) => s.type === 'local_path' && s.isDefault) ?? p.sources?.find((s) => s.type === 'local_path');
  // The project's own checkout when it's on this machine (boards and its bookshelf read it); a
  // stand-in folder when it isn't, so the floor still opens and its state still lives somewhere.
  const dir = source && existsSync(source.path) ? source.path : path.join(cfg.dataDir, 'bb', p.id, 'src');
  if (dir === path.join(cfg.dataDir, 'bb', p.id, 'src')) mkdirSync(dir, { recursive: true });
  return {
    id: `bb-${p.id}`,
    name: p.name,
    repo: parseRepo(p.gitRemoteUrl),
    dir,
    // Writable floor state (queue, workers, floorplan) stays out of the project's checkout.
    dataDir: path.join(cfg.dataDir, 'bb', p.id),
    palette: hash(p.id) % FLOOR_PALETTES.length,
    addedBy: 'BB',
    addedAt: 0,
  };
}

/** A thread's desk status, as the office says it (see WorkerStatus). */
export function threadStatus(t: BbThread): WorkerStatus {
  if (t.hasPendingInteraction) return 'needs_input';
  switch (t.status) {
    case 'active':
      return 'working';
    case 'pending':
      return 'starting';
    case 'error':
      return 'exited';
    default:
      return 'idle';
  }
}

/** Who gets a desk: whoever needs you, then whoever is busy, pinned or recently awake. */
function threadScore(t: BbThread, now: number): number {
  if (t.hasPendingInteraction) return 100;
  if (t.status === 'active') return 80;
  if (t.status === 'error') return 70;
  if (t.status === 'pending') return 50;
  if (t.pinnedAt) return 60;
  if (t.updatedAt && now - t.updatedAt < RECENT_MS) return 40;
  return 0;
}

/** Which threads get which desks, the highest-scoring first at their stable desk. */
export function seatThreads(threads: BbThread[], deskIds: string[], now = Date.now()): Map<string, string> {
  const eligible = threads
    .filter((t) => threadScore(t, now) > 0)
    .sort((a, b) => threadScore(b, now) - threadScore(a, now) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const taken = new Set<string>();
  const seats = new Map<string, string>();
  for (const t of eligible) {
    if (seats.size >= deskIds.length) break;
    const wanted = deskIds[hash(t.id) % deskIds.length];
    const desk = !taken.has(wanted) ? wanted : deskIds.find((d) => !taken.has(d));
    if (!desk) break;
    taken.add(desk);
    seats.set(t.id, desk);
  }
  return seats;
}

/** A thread's worker name: its stable one from the office's list, numbered if two would share it. */
function workerName(t: BbThread, used: Set<string>): string {
  const base = NAMES[hash(t.id) % NAMES.length];
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
  used.add(name);
  return name;
}

function summaryOf(t: BbThread): string {
  const bits = [t.providerId ?? 'agent', t.status ?? 'idle'];
  if (t.model) bits.splice(1, 0, t.model);
  return bits.join(' · ');
}

/** A thread as the worker at its desk. */
export function workerInfo(t: BbThread, deskId: string, name: string): WorkerInfo {
  const status = threadStatus(t);
  const title = (t.title ?? t.titleFallback ?? t.id).trim() || t.id;
  const provider = t.providerId ? PROVIDER_MAP[t.providerId] : undefined;
  return {
    id: t.id,
    kind: 'agent',
    ...(provider ? { provider } : {}),
    deskId,
    name,
    color: COLORS[hash(t.id) % COLORS.length],
    status,
    acked: status !== 'needs_input',
    createdBy: 'bb',
    createdAt: Date.now(),
    title,
    task: { name: truncate(title, 60), summary: summaryOf(t) },
    activity: truncate(title, 80),
    cols: 100,
    rows: 30,
    viewers: [],
    viewerIds: [],
  };
}

/** What a log entry says, as one line for the terminal. */
function eventLine(e: BbEvent): string {
  const time = new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const d = (e.data ?? {}) as Record<string, unknown>;
  const said = typeof d.text === 'string' ? d.text : typeof d.prompt === 'string' ? d.prompt : undefined;
  return `\r\n\x1b[2m${time}\x1b[0m ${said ? `${e.type}: ${truncate(said, 200)}` : e.type}`;
}

/**
 * One mirrored thread's terminal: the tail of its BB log, fetched when someone is watching it
 * and refreshed while they do. Implements what a desk's worker needs of its session.
 */
class MirrorSession implements WorkerSession {
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private fetched = false;
  private busy = false;

  constructor(
    private readonly threadId: string,
    private readonly write: (line: string) => void,
    private readonly viewed: () => boolean,
  ) {}

  /** The mirror loop's heartbeat: watch while watched, go quiet when nobody is. */
  tick(): void {
    if (!this.viewed()) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    this.timer ??= setInterval(() => void this.refresh(), LOG_MS);
    if (!this.fetched) void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const events = await runBb<BbEvent[]>('thread', 'log', this.threadId, '--after-seq', String(this.seq));
      if (!events?.length) return;
      this.fetched = true;
      this.seq = events[events.length - 1].seq;
      for (const e of events) this.write(eventLine(e));
    } finally {
      this.busy = false;
    }
  }

  writeInput(): void {
    // Keystrokes go nowhere: the thread runs in BB, not at this desk.
  }

  prompt(): void {
    this.write(`\r\n\x1b[2mThis desk mirrors BB thread ${this.threadId} — talk to it in BB for now.\x1b[0m\r\n`);
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function groupByProject(threads: BbThread[]): Map<string, BbThread[]> {
  const by = new Map<string, BbThread[]>();
  for (const t of threads) {
    const list = by.get(t.projectId);
    if (list) list.push(t);
    else by.set(t.projectId, [t]);
  }
  return by;
}

export async function startBbMirror(ctx: Ctx, openFloor: (def: FloorDef) => Floor | undefined): Promise<() => void> {
  const sessions = new Map<string, MirrorSession>(); // thread id -> its terminal's session
  const waitingSince = new Map<string, number>(); // thread id -> when it started needing you
  const { cfg } = ctx;
  let stopping = false;

  const syncFloors = async () => {
    const [projects, threads] = await Promise.all([runBb<BbProject[]>('project', 'list'), runBb<BbThread[]>('thread', 'list')]);
    if (stopping || !projects || !threads) return;
    const by = groupByProject(threads);
    const now = Date.now();
    // The busiest projects fill the elevator; quiet ones don't get a floor at all.
    const wanted = projects
      .filter((p) => (by.get(p.id) ?? []).some((t) => threadScore(t, now) > 0))
      .sort((a, b) => (by.get(b.id) ?? []).length - (by.get(a.id) ?? []).length)
      .slice(0, MAX_FLOORS);
    for (const f of [...ctx.floors.values()]) {
      if (f.def.id.startsWith('bb-') && !wanted.some((p) => `bb-${p.id}` === f.def.id)) ctx.closeFloor(f, 'BB');
    }
    for (const p of wanted) {
      if (!ctx.floors.has(`bb-${p.id}`)) {
        const f = openFloor(bbFloorDef(cfg, p));
        if (f) console.log(`agent-office: the ${f.def.name} floor mirrors BB project ${p.name}`);
      }
    }
    ctx.floorsChanged();
  };

  const syncThreads = async () => {
    const threads = await runBb<BbThread[]>('thread', 'list');
    if (stopping || !threads) return;
    const by = groupByProject(threads);
    const now = Date.now();
    for (const f of ctx.floors.values()) {
      if (!f.def.id.startsWith('bb-')) continue;
      const projectId = f.def.id.slice(3);
      const seats = seatThreads(by.get(projectId) ?? [], DESKS.map((d) => d.id), now);
      const seatedIds = new Set(seats.keys());
      // Gone quiet: off the desk.
      for (const w of f.workers.list()) {
        if (w.createdBy === 'bb' && !seatedIds.has(w.id)) {
          f.workers.seats.unseat(w.id);
          sessions.delete(w.id);
          waitingSince.delete(w.id);
        }
      }
      const used = new Set(f.workers.list().map((w) => w.name));
      for (const [threadId, deskId] of seats) {
        const thread = by.get(projectId)!.find((x) => x.id === threadId)!;
        const status = threadStatus(thread);
        if (status === 'needs_input') waitingSince.set(threadId, waitingSince.get(threadId) ?? now);
        else waitingSince.delete(threadId);
        const title = (thread.title ?? thread.titleFallback ?? threadId).trim() || threadId;
        if (!f.workers.get(threadId)) {
          let seated: Worker | undefined;
          const write = (line: string) => {
            if (!seated?.term) return;
            seated.term.write(line);
            seated.screenDirty = true;
          };
          const session = new MirrorSession(threadId, write, () => (seated?.info.viewers.length ?? 0) > 0);
          sessions.set(threadId, session);
          seated = f.workers.seats.seat(workerInfo(thread, deskId, workerName(thread, used)), session);
        } else {
          f.workers.seats.reseat(threadId, {
            deskId,
            status,
            acked: status !== 'needs_input',
            ...(waitingSince.get(threadId) ? { waitingSince: waitingSince.get(threadId) } : {}),
            title,
            task: { name: truncate(title, 60), summary: summaryOf(thread) },
            activity: truncate(title, 80),
          });
        }
      }
    }
    ctx.floorsChanged();
    for (const s of sessions.values()) s.tick();
  };

  // The building is there, with everyone at their desks, before anyone walks in.
  await syncFloors();
  void syncThreads();
  const floorsTimer = setInterval(() => void syncFloors(), FLOOR_MS);
  const threadsTimer = setInterval(() => void syncThreads(), THREAD_MS);
  return () => {
    stopping = true;
    clearInterval(floorsTimer);
    clearInterval(threadsTimer);
    for (const s of sessions.values()) s.close();
  };
}
