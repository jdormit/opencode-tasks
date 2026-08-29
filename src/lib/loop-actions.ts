/**
 * Shared mutation core for session loops.
 *
 * Both surfaces that can manipulate loops -- the `/loop*` slash
 * commands (`loop-commands.ts`) and the agent-facing tools
 * (`loop-tools.ts`) -- go through these functions so the DB row and the
 * in-process timer never drift apart. Each function returns a
 * discriminated union describing what happened; callers are responsible
 * for turning that into surface-appropriate prose.
 */

import type { TaskDatabase } from "./db.js";
import type { LoopRuntime } from "./loop-runtime.js";
import type { SessionLoop } from "./types.js";
import {
  intervalToCron,
  defaultExpiry,
  isExpired,
  LoopArgError,
} from "./loops.js";

/**
 * Shortest id prefix accepted when stopping a loop by id. Loop ids are
 * UUIDs; eight characters is enough to be unambiguous in practice while
 * staying short enough to retype.
 */
export const LOOP_ID_PREFIX_MIN = 8;

export type StartLoopResult =
  | { kind: "started"; loop: SessionLoop }
  | { kind: "invalid"; message: string };

export type StopLoopResult =
  /** One or more loops were disabled and their timers cleared. */
  | { kind: "stopped"; loops: SessionLoop[] }
  /** Stop-all was requested but the session had no active loops. */
  | { kind: "none" }
  | { kind: "not-found"; query: string }
  | { kind: "ambiguous"; query: string; matches: SessionLoop[] }
  | { kind: "already-stopped"; loop: SessionLoop };

/**
 * Create a loop for `sessionId` and arm its timer.
 *
 * `intervalLabel` is a human interval like "5m" or "2h"; invalid labels
 * and empty prompts come back as `{ kind: "invalid" }` rather than
 * throwing, so callers can render the message in their own voice.
 */
export function startLoop(opts: {
  db: TaskDatabase;
  runtime: LoopRuntime;
  sessionId: string;
  cwd: string;
  intervalLabel: string;
  prompt: string;
}): StartLoopResult {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    return { kind: "invalid", message: "A loop needs a non-empty prompt." };
  }

  let cron: string;
  try {
    cron = intervalToCron(opts.intervalLabel).cron;
  } catch (err: any) {
    if (err instanceof LoopArgError) {
      return { kind: "invalid", message: err.message };
    }
    throw err;
  }

  const loop = opts.db.createSessionLoop({
    sessionId: opts.sessionId,
    prompt,
    schedule: cron,
    intervalLabel: opts.intervalLabel.toLowerCase(),
    cwd: opts.cwd,
    expiresAt: defaultExpiry(),
  });

  opts.runtime.armNewLoop(loop);
  return { kind: "started", loop };
}

/**
 * Active (enabled) loops for a session, oldest first.
 */
export function listActiveLoops(
  db: TaskDatabase,
  sessionId: string,
  runtime?: LoopRuntime
): SessionLoop[] {
  const active: SessionLoop[] = [];
  for (const loop of db.listEnabledLoopsForSession(sessionId)) {
    if (isExpired(loop)) {
      runtime?.clearLoop(loop.id);
      db.disableSessionLoop(loop.id);
    } else {
      active.push(loop);
    }
  }
  return active;
}

/**
 * Disable every active loop in `sessionId` and clear their timers.
 */
export function stopAllLoops(
  db: TaskDatabase,
  runtime: LoopRuntime,
  sessionId: string
): StopLoopResult {
  const active = listActiveLoops(db, sessionId, runtime);
  for (const loop of active) {
    runtime.clearLoop(loop.id);
  }
  db.disableLoopsForSession(sessionId);
  return active.length === 0
    ? { kind: "none" }
    : { kind: "stopped", loops: active };
}

/**
 * Disable a single loop in `sessionId`, matched by full id or by an id
 * prefix of at least `LOOP_ID_PREFIX_MIN` characters.
 */
export function stopLoopById(
  db: TaskDatabase,
  runtime: LoopRuntime,
  sessionId: string,
  query: string
): StopLoopResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { kind: "not-found", query: trimmed };
  }

  const all = db.listLoopsForSession(sessionId);
  const candidates = all.filter(
    (l) =>
      l.id === trimmed ||
      (trimmed.length >= LOOP_ID_PREFIX_MIN && l.id.startsWith(trimmed))
  );

  if (candidates.length === 0) return { kind: "not-found", query: trimmed };
  if (candidates.length > 1) {
    return { kind: "ambiguous", query: trimmed, matches: candidates };
  }

  const loop = candidates[0];
  if (!loop.enabled) return { kind: "already-stopped", loop };

  runtime.clearLoop(loop.id);
  db.disableSessionLoop(loop.id);
  return { kind: "stopped", loops: [loop] };
}
