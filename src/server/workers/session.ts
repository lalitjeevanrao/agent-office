// A worker whose brain is a protocol conversation rather than a process in a PTY: DeepSeek
// Harness over ACP (dsh.ts), or a BB thread mirrored onto a desk (bbmirror.ts). Narrow on
// purpose, like WorkerHandle: DshSession satisfies it structurally without knowing about it.

export interface WorkerSession {
  /** The session is over: stop whatever it keeps running. */
  close(): void;
  /** Keystrokes from a browser with the worker's terminal open. */
  writeInput(data: string): void;
  /** Someone typed a message to the worker; a session that can't take one says why in its terminal. */
  prompt(text: string): void;
}
