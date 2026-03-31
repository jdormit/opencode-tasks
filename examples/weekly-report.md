---
description: Generate a weekly summary of project activity
schedule: "0 8 * * 1"
cwd: ~/projects/my-app
model: anthropic/claude-sonnet-4-6
permission:
  bash:
    "*": "allow"
  edit: "deny"
enabled: true
---

Generate a weekly summary of project activity for the past 7 days. Include:

1. All commits with brief descriptions
2. Files changed (grouped by directory)
3. Any open PRs and their status
4. A brief analysis of development velocity and focus areas

Format the output as a clean markdown report.
