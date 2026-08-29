import { type Plugin, tool } from "@opencode-ai/plugin";
import { TaskDatabase, getDefaultDbPath } from "./lib/db.js";
import { readAllTasks, getTasksDir, setTaskEnabled } from "./lib/tasks.js";
import { getNextRunTime, isValidCron } from "./lib/cron.js";
import { isInstalled } from "./lib/installer.js";
import {
  scheduleOneoffTask,
  formatScheduledTaskMessage,
  ScheduleTaskError,
} from "./lib/schedule.js";
import type { SessionLoop } from "./lib/types.js";
import { LoopRuntime, type LoopLogger } from "./lib/loop-runtime.js";
import {
  handleLoopCommand,
  handleLoopStopCommand,
  handleLoopListCommand,
  handleLoopEvent,
} from "./lib/loop-commands.js";
import {
  executeListLoopsTool,
  executeStartLoopTool,
  executeStopLoopTool,
} from "./lib/loop-tools.js";


function getDb(): TaskDatabase {
  return new TaskDatabase(getDefaultDbPath());
}

/**
 * Build the TextPartInput list for a `/loop*` slash command reply.
 *
 * We can't suppress the LLM round-trip (opencode has no `noReply`
 * option for `command.execute.before` as of writing -- see
 * anomalyco/opencode#9306), and sending an all-`ignored` message
 * fails provider validation ("messages: at least one message is
 * required" / "must end with a user message"). So we emit two parts:
 *
 *  - An `ignored: true` text with the user-facing confirmation. The
 *    TUI shows it; the LLM never sees it.
 *    (Filtered out of the LLM request by `message-v2.ts:802` and
 *    `prompt.ts:1551`. Shown in the transcript because the TUI's
 *    transcript formatter only skips `synthetic` parts.)
 *
 *  - A `synthetic: true` text containing factual context plus
 *    instructions for the model to write a short, conversational
 *    acknowledgement. The LLM sees this and replies; the user does
 *    NOT see it in the transcript.
 *    (Shown to the LLM because `message-v2.ts:802` only filters on
 *    `ignored`. Hidden in the transcript because the TUI's
 *    transcript formatter explicitly skips `synthetic` parts.)
 *
 * This is the best we can do until opencode supports a no-LLM
 * branch in `command.execute.before`.
 */
function commandReplyParts(reply: { visible: string; context: string }): any[] {
  return [
    { type: "text", text: reply.visible, ignored: true },
    {
      type: "text",
      text: buildSyntheticInstruction(reply.context),
      synthetic: true,
    },
  ];
}

/**
 * Compose the instruction the LLM sees for a `/loop*` slash command.
 * The model receives a factual summary of what the plugin just did,
 * plus explicit guidance to reply with one short, conversational
 * sentence in its own words.
 */
function buildSyntheticInstruction(context: string): string {
  return [
    `The opencode-tasks plugin just handled a /loop slash command on the user's behalf and has already shown a detailed confirmation to the user in the transcript above.`,
    ``,
    `Summary of what happened: the plugin ${context}.`,
    ``,
    `Reply with a single short, friendly sentence acknowledging this in your own words. Do not repeat the confirmation details, do not explain what /loop does, do not offer further help. Just a brief, conversational acknowledgement so the user knows you saw it.`,
  ].join("\n");
}

/**
 * Replace the contents of opencode's `output.parts` array in place.
 *
 * The caller in `session/prompt.ts:1736` invokes the hook as
 * `plugin.trigger("command.execute.before", input, { parts })` and
 * then immediately uses the same `parts` reference to build the
 * actual prompt -- the return value of `trigger()` is discarded.
 * That means assigning `output.parts = [...]` does nothing useful:
 * we have to mutate the existing array so the caller sees our
 * replacement.
 */
function replaceParts(output: { parts: any[] }, parts: any[]): void {
  output.parts.length = 0;
  for (const p of parts) output.parts.push(p);
}

function schedulerWarning(): string {
  if (!isInstalled()) {
    return "\n\nNote: The opencode-tasks daemon is not installed. Tasks will only execute when the scheduler is run manually. Install it with: bunx opencode-tasks --install";
  }
  return "";
}

export const ScheduledTasksPlugin: Plugin = async (ctx) => {
  // ---- Session-loop runtime ----------------------------------------------
  //
  // One LoopRuntime per plugin instance (i.e. per opencode process).
  // Owns its own DB handle so the runtime stays usable for the lifetime
  // of the opencode process; the per-call tools above continue to open
  // and close short-lived handles via getDb() so we don't fight over the
  // single open connection.
  const loopDb = getDb();

  const loopLogger: LoopLogger = {
    info: (message) => {
      try {
        ctx.client.app.log({
          body: { service: "opencode-tasks", level: "info", message },
        });
      } catch {
        // Logging failures are non-fatal.
      }
    },
    warn: (message) => {
      try {
        ctx.client.app.log({
          body: { service: "opencode-tasks", level: "warn", message },
        });
      } catch {
        // ignore
      }
    },
    error: (message) => {
      try {
        ctx.client.app.log({
          body: { service: "opencode-tasks", level: "error", message },
        });
      } catch {
        // ignore
      }
    },
  };

  const loopRuntime = new LoopRuntime({
    db: loopDb,
    logger: loopLogger,
    deliver: async (loop: SessionLoop) => {
      await ctx.client.session.promptAsync({
        path: { id: loop.sessionId },
        query: { directory: loop.cwd },
        body: {
          parts: [{ type: "text", text: loop.prompt }],
        },
      });
    },
  });

  return {
    tool: {
      schedule_task: tool({
        description:
          "Schedule a one-off task to run at a specific time. The task will execute an opencode prompt in the specified working directory. Requires the opencode-tasks daemon to be installed for reliable execution.",
        args: {
          prompt: tool.schema.string(
            "The prompt to send to opencode when the task runs"
          ),
          description: tool.schema.string(
            "Human-readable description of what this task does"
          ),
          cwd: tool.schema.string(
            "Working directory for the task (absolute path or ~ for home)"
          ),
          scheduled_at: tool.schema.string(
            "ISO 8601 timestamp for when to run (e.g. '2026-03-31T09:00:00')"
          ),
          session_name: tool.schema
            .string()
            .optional()
            .describe("Session name. If set, reuses the same session across runs. If omitted, creates a fresh session each run."),
          model: tool.schema
            .string()
            .optional()
            .describe("Model in provider/model format"),
          agent: tool.schema
            .string()
            .optional()
            .describe("Agent to use for execution"),
          permission: tool.schema
            .string()
            .optional()
            .describe(
              "Permission config as a JSON string (same schema as opencode.json permissions). Example: '{\"bash\":{\"*\":\"allow\"},\"edit\":\"allow\"}'"
            ),
        },
        async execute(args) {
          const db = getDb();
          try {
            const task = scheduleOneoffTask(db, {
              description: args.description,
              prompt: args.prompt,
              cwd: args.cwd,
              scheduledAt: args.scheduled_at,
              sessionName: args.session_name,
              model: args.model,
              agent: args.agent,
              permission: args.permission,
              rejectPastDate: true,
            });
            return formatScheduledTaskMessage(task) + schedulerWarning();
          } catch (err) {
            if (err instanceof ScheduleTaskError) {
              return `Error: ${err.message}`;
            }
            throw err;
          } finally {
            db.close();
          }
        },
      }),

      list_tasks: tool({
        description:
          "List all scheduled tasks. Shows recurring tasks from markdown files and pending one-off tasks. Includes next run time for recurring tasks and scheduled time for one-offs.",
        args: {
          status: tool.schema
            .enum(["all", "pending", "completed", "failed"])
            .optional()
            .describe("Filter by status (default: all)"),
          type: tool.schema
            .enum(["all", "recurring", "oneoff"])
            .optional()
            .describe("Filter by type (default: all)"),
        },
        async execute(args) {
          const status = args.status ?? "all";
          const type = args.type ?? "all";
          const db = getDb();
          const lines: string[] = [];

          try {
            // Recurring tasks
            if (type === "all" || type === "recurring") {
              const { tasks, errors } = readAllTasks();

              if (tasks.length > 0) {
                lines.push("## Recurring Tasks\n");
                for (const task of tasks) {
                  const lastRun = db.getLastTaskRun(task.name);
                  const statusStr = task.enabled ? "enabled" : "disabled";
                  let nextStr = "N/A";
                  if (task.enabled) {
                    try {
                      nextStr = getNextRunTime(task.schedule);
                    } catch {
                      nextStr = "invalid cron expression";
                    }
                  }

                  lines.push(`- **${task.name}** (${statusStr})`);
                  lines.push(`  Schedule: \`${task.schedule}\``);
                  lines.push(`  CWD: ${task.cwd}`);
                  lines.push(`  Next run: ${nextStr}`);
                  if (lastRun) {
                    lines.push(
                      `  Last run: ${lastRun.status} at ${lastRun.startedAt}`
                    );
                  } else {
                    lines.push(`  Last run: never`);
                  }
                  lines.push("");
                }
              } else {
                lines.push("No recurring tasks found.\n");
              }

              if (errors.length > 0) {
                lines.push("### Task file errors:\n");
                for (const { file, error } of errors) {
                  lines.push(`- ${file}: ${error}`);
                }
                lines.push("");
              }
            }

            // One-off tasks
            if (type === "all" || type === "oneoff") {
              const oneoffs = db.listOneoffTasks({
                status: status === "all" ? "all" : (status as any),
              });

              if (oneoffs.length > 0) {
                lines.push("## One-off Tasks\n");
                for (const task of oneoffs) {
                  lines.push(`- **${task.description}** [${task.status}]`);
                  lines.push(`  ID: ${task.id}`);
                  lines.push(`  Scheduled: ${task.scheduledAt}`);
                  lines.push(`  CWD: ${task.cwd}`);
                  if (task.sessionId) {
                    lines.push(`  Session: ${task.sessionId}`);
                  }
                  if (task.error) {
                    lines.push(`  Error: ${task.error}`);
                  }
                  lines.push("");
                }
              } else {
                lines.push(
                  `No one-off tasks found${status !== "all" ? ` with status "${status}"` : ""}.\n`
                );
              }
            }

            return lines.join("\n") + schedulerWarning();
          } finally {
            db.close();
          }
        },
      }),

      cancel_task: tool({
        description:
          "Cancel a pending one-off task by ID, or disable a recurring task by name.",
        args: {
          id: tool.schema.string(
            "Task ID (for one-off, a UUID) or task name (for recurring)"
          ),
        },
        async execute(args) {
          const db = getDb();
          try {
            // Try as one-off task ID first (UUIDs contain hyphens)
            if (args.id.includes("-")) {
              const task = db.getOneoffTask(args.id);
              if (task) {
                if (task.status !== "pending") {
                  return `Cannot cancel task: status is "${task.status}" (must be "pending")`;
                }
                db.cancelOneoffTask(args.id);
                return `Cancelled one-off task: ${task.description} (${task.id})`;
              }
            }

            // Try as recurring task name
            const { tasks } = readAllTasks();
            const recurringTask = tasks.find((t) => t.name === args.id);
            if (recurringTask) {
              setTaskEnabled(recurringTask.filePath, false);
              return `Disabled recurring task: ${recurringTask.name}\nFile updated: ${recurringTask.filePath}`;
            }

            return `No task found with ID or name "${args.id}"`;
          } finally {
            db.close();
          }
        },
      }),

      start_loop: tool({
        description:
          "Start a recurring prompt in the current session. Use this for in-session polling or repeated work that should run only while OpenCode is open. Loops expire after 3 days by default.",
        args: {
          prompt: tool.schema.string(
            "The prompt to send to this session each time the loop runs"
          ),
          interval: tool.schema
            .string()
            .optional()
            .describe(
              "Interval as a number plus m, h, or d (for example 5m, 2h, or 1d). Defaults to 5m."
            ),
        },
        async execute(args, context) {
          loopRuntime.ensureSessionArmed(context.sessionID);
          return executeStartLoopTool(args, context, loopDb, loopRuntime);
        },
      }),

      list_loops: tool({
        description:
          "List active recurring loops in the current session, including their IDs, intervals, prompts, and expiry times.",
        args: {},
        async execute(_args, context) {
          loopRuntime.ensureSessionArmed(context.sessionID);
          return executeListLoopsTool(context, loopDb, loopRuntime);
        },
      }),

      stop_loop: tool({
        description:
          "Stop one recurring loop in the current session by ID. Call list_loops first if you do not know the loop ID.",
        args: {
          id: tool.schema
            .string()
            .min(8)
            .describe(
              "The full loop ID or an unambiguous prefix of at least 8 characters"
            ),
        },
        async execute(args, context) {
          loopRuntime.ensureSessionArmed(context.sessionID);
          return executeStopLoopTool(args, context, loopDb, loopRuntime);
        },
      }),

      task_history: tool({
        description:
          "Get the execution history for a scheduled task. Shows recent runs with status, timing, and any errors.",
        args: {
          task_name: tool.schema.string(
            "Task name (for recurring) or task ID (for one-off)"
          ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of history entries to show (default: 10)"),
        },
        async execute(args) {
          const limit = args.limit ?? 10;
          const db = getDb();

          try {
            // Try as one-off task
            if (args.task_name.includes("-")) {
              const task = db.getOneoffTask(args.task_name);
              if (task) {
                const lines = [
                  `## One-off Task: ${task.description}\n`,
                  `- ID: ${task.id}`,
                  `- Status: ${task.status}`,
                  `- Scheduled: ${task.scheduledAt}`,
                  `- Created: ${task.createdAt}`,
                  `- CWD: ${task.cwd}`,
                ];
                if (task.executedAt) lines.push(`- Executed: ${task.executedAt}`);
                if (task.sessionId) lines.push(`- Session: ${task.sessionId}`);
                if (task.error) lines.push(`- Error: ${task.error}`);
                return lines.join("\n");
              }
            }

            // Try as recurring task
            const runs = db.getTaskRunHistory(args.task_name, limit);
            if (runs.length === 0) {
              return `No history found for task "${args.task_name}"`;
            }

            const lines = [`## History for "${args.task_name}"\n`];
            for (const run of runs) {
              lines.push(`- **${run.status}** at ${run.startedAt}`);
              if (run.completedAt) {
                const duration =
                  new Date(run.completedAt).getTime() -
                  new Date(run.startedAt).getTime();
                lines.push(`  Duration: ${Math.round(duration / 1000)}s`);
              }
              if (run.sessionId) lines.push(`  Session: ${run.sessionId}`);
              if (run.error) lines.push(`  Error: ${run.error}`);
            }

            return lines.join("\n");
          } finally {
            db.close();
          }
        },
      }),

      get_task_instructions: tool({
        description:
          "Get instructions and the frontmatter format for creating or editing recurring scheduled task markdown files. Use this when the user wants to set up a new recurring task or modify an existing one. After getting instructions, use file tools to create/edit the task file.",
        args: {},
        async execute() {
          const tasksDir = getTasksDir();
          return `## Creating a Recurring Scheduled Task

Recurring tasks are defined as markdown files in:
  ${tasksDir}

The filename (without \`.md\`) is used as the task name. Each file contains YAML frontmatter followed by the prompt.

### Frontmatter Format

\`\`\`yaml
---
description: Clean up old branches  # Optional. Human-readable description
schedule: "0 9 * * *"        # Required. 5-field cron expression
cwd: ~/projects/my-app       # Required. Working directory (~ is expanded)
session_name: daily-cleanup   # Optional. Reuses the same session across runs. Omit for fresh session each run.
model: anthropic/claude-sonnet-4-6  # Optional. Model to use
agent: build                  # Optional. Agent to use
timeout: 1h                  # Optional. Maximum run time; default: 1h. Numbers are seconds.
permission:                   # Optional. Same format as opencode.json permissions
  bash:
    "*": "allow"
    "rm -rf *": "deny"
  edit: "allow"
  external_directory:          # IMPORTANT for accessing files outside cwd
    "/tmp/*": "allow"
enabled: true                 # Optional. Default: true
---

The prompt goes here. This is what will be sent to the opencode agent when the task runs.
\`\`\`

### Permissions - IMPORTANT

Since scheduled tasks run in the background with no user present, any permission set to \`"ask"\` will effectively be **denied**. You must explicitly allow any operations the task needs.

**Never use \`"ask"\` in a scheduled task.** There is nobody around to answer the prompt. Use \`"allow"\` for things the task should be able to do and \`"deny"\` for things it shouldn't. If you find yourself reaching for \`"ask"\`, you almost certainly want \`"deny"\`.

**Rule order matters.** OpenCode evaluates permission rules in declaration order, and the **last matching rule wins** — not the most specific. Put the catch-all \`"*"\` rule first, and put more-specific overrides after it. If you flip the order, the catch-all will silently override every specific rule above it:

\`\`\`yaml
# WRONG — "*": "deny" comes last and overrides "git *": "allow".
bash:
  "git *": "allow"
  "*": "deny"

# RIGHT — catch-all first, specifics after.
bash:
  "*": "deny"
  "git *": "allow"
\`\`\`

**Most commonly missed: \`external_directory\`** - This defaults to \`"ask"\` and controls access to files outside the task's \`cwd\`. If your task writes to \`/tmp\`, reads from another project, or accesses any path outside \`cwd\`, you MUST add an \`external_directory\` rule:

\`\`\`yaml
permission:
  external_directory:
    "/tmp/*": "allow"
    "~/other-project/*": "allow"
\`\`\`

Other permissions like \`bash\` and \`edit\` default to \`"allow"\` and usually don't need explicit rules unless you want to restrict them.

### Cron Expression Reference

\`\`\`
┌───────── minute (0-59)
│ ┌───────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌───────── month (1-12)
│ │ │ │ ┌───────── day of week (0-7, 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
\`\`\`

Common examples:
- \`0 9 * * *\` - Every day at 9:00 AM
- \`0 9 * * 1-5\` - Every weekday at 9:00 AM
- \`*/30 * * * *\` - Every 30 minutes
- \`0 0 * * 0\` - Every Sunday at midnight
- \`0 9 1 * *\` - First day of every month at 9:00 AM

### Notes

- The scheduler daemon must be installed for tasks to run automatically:
  \`bunx opencode-tasks --install\`
- Tasks use your system's local timezone
- Tasks with \`session_name\` set will reuse the same session across runs
- Use \`enabled: false\` to temporarily disable a task without deleting it

### When to use recurring tasks vs. one-off tasks vs. /loop

- **Recurring task** (markdown file): runs in a *fresh* opencode subprocess on a cron schedule. Good for background work that should run whether or not the user is in opencode.
- **One-off task** (\`schedule_task\` tool): runs once in a fresh subprocess. Good for "remind me at 3pm" or "run this once tomorrow."
- **Session loop** (\`start_loop\`, \`list_loops\`, and \`stop_loop\` tools, or the \`/loop*\` slash commands): posts a recurring prompt into the *current user session*. Good for in-session polling — checking CI, deploys, and file watchers. Only fires while the session is open.${schedulerWarning()}`;
        },
      }),
    },

    "command.execute.before": async (input, output) => {
      const command = input.command;
      if (command !== "loop" && command !== "loop-stop" && command !== "loop-list") {
        return;
      }

      const sessionId = input.sessionID;
      if (!sessionId) {
        replaceParts(
          output,
          commandReplyParts({
            visible:
              "Error: no session id available for /loop. This command must be run inside an opencode session.",
            context:
              "tried to handle the slash command but the plugin couldn't see a session id",
          })
        );
        return;
      }

      // Make sure any pre-existing loops for this session are armed
      // before we do anything else (handles --resume cleanly).
      try {
        loopRuntime.ensureSessionArmed(sessionId);
      } catch {
        // Non-fatal.
      }

      try {
        let reply: { visible: string; context: string } | undefined;
        if (command === "loop") {
          reply = handleLoopCommand(
            input.arguments ?? "",
            sessionId,
            ctx.directory,
            loopDb,
            loopRuntime
          );
        } else if (command === "loop-stop") {
          reply = handleLoopStopCommand(
            input.arguments ?? "",
            sessionId,
            loopDb,
            loopRuntime
          );
        } else if (command === "loop-list") {
          reply = handleLoopListCommand(sessionId, loopDb, loopRuntime);
        }
        if (reply !== undefined) {
          replaceParts(output, commandReplyParts(reply));
        }
      } catch (err: any) {
        const message = err?.message ?? String(err);
        replaceParts(
          output,
          commandReplyParts({
            visible: `Error: ${message}`,
            context: `crashed while handling the slash command: ${message}`,
          })
        );
      }
    },

    event: async ({ event }: { event: any }) => {
      // Loop bookkeeping: re-arm on first sight of a session, clean up
      // when a session is deleted.
      handleLoopEvent(event, loopDb, loopRuntime, loopLogger);

      // Opportunistic overdue-task check on session creation.
      if (event.type === "session.created") {
        try {
          const db = getDb();
          try {
            const overdueTasks = db.getDueOneoffTasks();
            if (overdueTasks.length > 0 && !isInstalled()) {
              await ctx.client.app.log({
                body: {
                  service: "opencode-tasks",
                  level: "warn",
                  message: `${overdueTasks.length} overdue task(s) found but scheduler daemon is not installed. Run: bunx opencode-tasks --install`,
                },
              });
            }
          } finally {
            db.close();
          }
        } catch {
          // Don't let plugin errors crash the session
        }
      }
    },
  };
};

export default ScheduledTasksPlugin;
