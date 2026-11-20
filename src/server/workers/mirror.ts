// Seating BB threads at desks: a mirrored worker is shown, never run (see bbmirror.ts). Narrow like
// the other workers modules, and built on WorkerContext, so the mirror never reaches into the manager.
import { newTracker } from '../usage.js';
import { newTerm } from './terminal.js';
import { newWorker } from './worker.js';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { WorkerSession } from './session.js';
import type { Worker, WorkerContext } from './types.js';

export class WorkerSeats {
  constructor(private readonly ctx: WorkerContext) {}

  /** Seats a worker the office doesn't run — a BB thread mirrored onto a desk (see bbmirror.ts). */
  seat(info: WorkerInfo, session: WorkerSession): Worker {
    const w = newWorker(info, newTracker());
    w.mirror = true;
    w.dsh = session;
    this.ctx.workers.set(info.id, w);
    // Its terminal shows what the session renders, like an ACP worker's (see launchAcp).
    newTerm(w, { title: () => {} });
    this.ctx.emit(w);
    return w;
  }

  /** A mirrored worker's thread changed shape (see bbmirror.ts): new status, task, title. */
  reseat(id: string, patch: Partial<WorkerInfo>): void {
    const w = this.ctx.workers.get(id);
    if (!w?.mirror) return;
    Object.assign(w.info, patch);
    this.ctx.emit(w);
  }

  /** Takes a mirrored worker off its desk (see bbmirror.ts). No process, no worktree, nothing persisted. */
  unseat(id: string): void {
    const w = this.ctx.workers.get(id);
    if (!w?.mirror) return;
    this.ctx.workers.delete(id);
    w.dsh?.close();
    w.term?.dispose();
    this.ctx.events.remove(id, w.info);
  }
}
