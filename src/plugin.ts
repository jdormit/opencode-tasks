import { type Plugin, tool } from "@opencode-ai/plugin";
import { TaskDatabase, getDefaultDbPath } from "./lib/db.js";
import { readAllTasks, getTasksDir, expandPath, setTaskEnabled } from "./lib/tasks.js";
import { getNextRunTime, isValidCron } from "./lib/cron.js";
import { isInstalled } from "./lib/installer.js";


function getDb(): TaskDatabase {
  return new TaskDatabase(getDefaultDbPath());
}

function schedulerWarning(): string {
  if (!isInstalled()) {
    return "\n\nNote: The opencode-scheduler daemon is not installed. Tasks will only execute when the scheduler is run manually. Install it with: npx opencode-scheduler --install";
  }
  return "";
}

export const ScheduledTasksPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      schedule_task: tool({
        description:
          "Schedule a one-off task to run at a specific time. The task will execute an opencode prompt in the specified working directory. Requires the opencode-scheduler daemon to be installed for reliable execution.",
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
          // Validate
          const scheduledDate = new Date(args.scheduled_at);
          if (isNaN(scheduledDate.getTime())) {
            return `Error: Invalid date format "${args.scheduled_at}". Use ISO 8601 format (e.g. '2026-03-31T09:00:00').`;
          }

          if (scheduledDate <= new Date()) {
            return `Error: Scheduled time "${args.scheduled_at}" is in the past.`;
          }

          const cwd = expandPath(args.cwd);

          let permission: any;
          if (args.permission) {
            try {
              permission = JSON.parse(args.permission);
            } catch {
              return `Error: Invalid permission JSON: ${args.permission}`;
            }
          }

          const db = getDb();
          try {
            const task = db.createOneoffTask({
              description: args.description,
              prompt: args.prompt,
              cwd,
              scheduledAt: scheduledDate.toISOString(),
              sessionName: args.session_name,
              model: args.model,
              agent: args.agent,
              permission,
            });

            return (
              `Task scheduled successfully!\n` +
              `  ID: ${task.id}\n` +
              `  Description: ${task.description}\n` +
              `  Scheduled for: ${task.scheduledAt}\n` +
              `  Working directory: ${task.cwd}\n` +
              `  Session: ${task.sessionName ? `named (${task.sessionName})` : "new (fresh each run)"}` +
              schedulerWarning()
            );
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

Each file should be named after the task (e.g., \`daily-cleanup.md\`) and contain YAML frontmatter followed by the prompt.

### Frontmatter Format

\`\`\`yaml
---
name: daily-cleanup          # Required. Must match filename (without .md)
description: Clean up old branches  # Required. Human-readable description
schedule: "0 9 * * *"        # Required. 5-field cron expression
cwd: ~/projects/my-app       # Required. Working directory (~ is expanded)
session_name: daily-cleanup   # Optional. Reuses the same session across runs. Omit for fresh session each run.
model: anthropic/claude-sonnet-4-6  # Optional. Model to use
agent: build                  # Optional. Agent to use
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
  \`npx opencode-scheduler --install\`
- Tasks use your system's local timezone
- Tasks with \`session_name\` set will reuse the same session across runs
- Use \`enabled: false\` to temporarily disable a task without deleting it${schedulerWarning()}`;
        },
      }),
    },

    event: async ({ event }: { event: any }) => {
      if (event.type === "session.created") {
        // Opportunistically check for overdue tasks
        try {
          const db = getDb();
          try {
            const overdueTasks = db.getDueOneoffTasks();
            if (overdueTasks.length > 0 && !isInstalled()) {
              await ctx.client.app.log({
                body: {
                  service: "opencode-scheduled-tasks",
                  level: "warn",
                  message: `${overdueTasks.length} overdue task(s) found but scheduler daemon is not installed. Run: npx opencode-scheduler --install`,
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
