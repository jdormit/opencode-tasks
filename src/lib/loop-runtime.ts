/**
 * In-process timer runtime for session loops.
 *
 * The plugin owns a single `LoopRuntime` instance per opencode process.
 * Timers are ephemeral; durable state lives in the `session_loops` SQLite
 * table. On plugin reload (e.g. `opencode --resume`), timers are
 * re-armed lazily the first time we see an event for a given session.
 *
 * This module is split out from `plugin.ts` so it can be unit-tested
 * without standing up an opencode plugin context.
 */

import type { TaskDatabase } from "./db.js";
import { isExpired, msUntilNextCronTick } from "./loops.js";
import type { SessionLoop } from "./types.js";

/**
 * Callback that delivers a prompt for a fired loop. The plugin wires
 * this up to `client.session.promptAsync`. Returning false (or
 * throwing) causes the loop to log the failure and keep going — we
 * don't disable a loop on transient delivery errors.
 */
export type PromptDeliverer = (loop: SessionLoop) => Promise<void>;

/**
 * Logger interface used for diagnostic output. The plugin forwards
 * these to `ctx.client.app.log`; tests can pass a no-op.
 */
export interface LoopLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoopRuntimeOptions {
  db: TaskDatabase;
  deliver: PromptDeliverer;
  logger?: LoopLogger;
  /**
   * Optional override for the timer scheduler. Defaults to global
   * `setTimeout`/`clearTimeout`. Tests can substitute a fake clock.
   */
  setTimeoutFn?: (cb: () => void, ms: number) => any;
  clearTimeoutFn?: (handle: any) => void;
}

const NO_OP_LOGGER: LoopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class LoopRuntime {
  private readonly db: TaskDatabase;
  private readonly deliver: PromptDeliverer;
  private readonly logger: LoopLogger;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => any;
  private readonly clearTimeoutFn: (handle: any) => void;

  /** Armed timers, keyed by loop id. */
  private readonly timers = new Map<string, any>();
  /** Sessions whose loops have been loaded from the DB at least once this process. */
  private readonly seenSessions = new Set<string>();

  constructor(opts: LoopRuntimeOptions) {
    this.db = opts.db;
    this.deliver = opts.deliver;
    this.logger = opts.logger ?? NO_OP_LOGGER;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Re-arm timers for any enabled loops belonging to `sessionId` the
   * first time we see that session this process. Idempotent across
   * repeated calls.
   */
  ensureSessionArmed(sessionId: string): void {
    if (!sessionId) return;
    if (this.seenSessions.has(sessionId)) return;
    this.seenSessions.add(sessionId);

    const loops = this.db.listEnabledLoopsForSession(sessionId);
    for (const loop of loops) {
      if (isExpired(loop)) {
        this.logger.info(
          `Loop ${loop.id} expired; disabling instead of arming`
        );
        this.db.disableSessionLoop(loop.id);
        continue;
      }
      this.armLoop(loop);
    }
    if (loops.length > 0) {
      this.logger.info(
        `Armed ${loops.length} loop(s) for session ${sessionId}`
      );
    }
  }

  /**
   * Arm a freshly-created loop. Call this after inserting the row.
   */
  armNewLoop(loop: SessionLoop): void {
    // Make sure the session is marked as seen so a future re-arm pass
    // doesn't try to double-arm.
    this.seenSessions.add(loop.sessionId);
    this.armLoop(loop);
  }

  /**
   * Schedule a single firing for `loop`. On fire: deliver the prompt,
   * stamp last_run_at, then re-arm for the next tick if the row is
   * still enabled and not expired.
   *
   * If a timer for this loop is already armed, the existing one is
   * cleared first.
   */
  private armLoop(loop: SessionLoop): void {
    this.clearLoop(loop.id);

    const ms = msUntilNextCronTick(loop.schedule);
    const handle = this.setTimeoutFn(() => {
      void this.fireLoop(loop.id);
    }, ms);
    this.timers.set(loop.id, handle);
  }

  private async fireLoop(loopId: string): Promise<void> {
    this.timers.delete(loopId);

    const fresh = this.db.getSessionLoop(loopId);
    if (!fresh) return;
    if (!fresh.enabled) return;
    if (isExpired(fresh)) {
      this.db.disableSessionLoop(fresh.id);
      this.logger.info(`Loop ${fresh.id} expired; disabling`);
      return;
    }

    try {
      await this.deliver(fresh);
      this.db.setLoopLastRun(fresh.id, new Date().toISOString());
    } catch (err: any) {
      this.logger.error(
        `Loop ${fresh.id} delivery failed: ${err?.message ?? err}`
      );
      // Continue scheduling — transient failures shouldn't kill the loop.
    }

    // Re-arm using the latest row state (it may have changed during delivery).
    const next = this.db.getSessionLoop(loopId);
    if (next && next.enabled && !isExpired(next)) {
      this.armLoop(next);
    }
  }

  /**
   * Clear a single armed timer if any. Does not touch the DB.
   */
  clearLoop(loopId: string): void {
    const t = this.timers.get(loopId);
    if (t !== undefined) {
      this.clearTimeoutFn(t);
      this.timers.delete(loopId);
    }
  }

  /**
   * Clear all timers for a given session.
   */
  clearSession(sessionId: string): void {
    const loops = this.db.listLoopsForSession(sessionId);
    for (const loop of loops) {
      this.clearLoop(loop.id);
    }
    this.seenSessions.delete(sessionId);
  }

  /**
   * For tests: number of currently armed timers.
   */
  armedCount(): number {
    return this.timers.size;
  }

  /**
   * For tests: whether a specific loop is currently armed.
   */
  isArmed(loopId: string): boolean {
    return this.timers.has(loopId);
  }
}
