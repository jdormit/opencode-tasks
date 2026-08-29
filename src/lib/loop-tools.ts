import type { TaskDatabase } from "./db.js";
import {
  listActiveLoops,
  startLoop,
  stopLoopById,
} from "./loop-actions.js";
import type { LoopRuntime } from "./loop-runtime.js";
import {
  DEFAULT_INTERVAL_LABEL,
  formatLoopConfirmation,
  formatLoopList,
  formatLoopStopped,
} from "./loops.js";

export interface LoopToolContext {
  sessionID: string;
  directory: string;
}

export function executeStartLoopTool(
  args: { prompt: string; interval?: string },
  context: LoopToolContext,
  db: TaskDatabase,
  runtime: LoopRuntime
): string {
  const result = startLoop({
    db,
    runtime,
    sessionId: context.sessionID,
    cwd: context.directory,
    intervalLabel: args.interval ?? DEFAULT_INTERVAL_LABEL,
    prompt: args.prompt,
  });

  if (result.kind === "invalid") return `Error: ${result.message}`;
  return formatLoopConfirmation(result.loop, {
    stopHint: `Stop with the stop_loop tool using id ${result.loop.id}.`,
  });
}

export function executeListLoopsTool(
  context: LoopToolContext,
  db: TaskDatabase,
  runtime: LoopRuntime
): string {
  return formatLoopList(listActiveLoops(db, context.sessionID, runtime), {
    emptyHint: "Use the start_loop tool to start one.",
  });
}

export function executeStopLoopTool(
  args: { id: string },
  context: LoopToolContext,
  db: TaskDatabase,
  runtime: LoopRuntime
): string {
  const result = stopLoopById(
    db,
    runtime,
    context.sessionID,
    args.id
  );

  switch (result.kind) {
    case "stopped":
      return formatLoopStopped(result.loops);
    case "already-stopped":
      return `Loop ${result.loop.id} is already stopped.`;
    case "ambiguous":
      return `Ambiguous id "${result.query}" matches ${result.matches.length} loops; provide more characters.`;
    case "not-found":
      return `No loop matching "${result.query}" in this session. Use list_loops to see active loops.`;
    case "none":
      return "No active loops in this session.";
  }
}
