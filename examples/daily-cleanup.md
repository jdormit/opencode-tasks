---
description: Clean up merged git branches
schedule: "0 9 * * *"
cwd: ~/projects/my-app
session_name: daily-cleanup
permission:
  bash:
    "*": "allow"
    "git push *": "deny"
  edit: "deny"
enabled: true
---

Check for local branches that have been merged into main and delete them.
List any branches that look stale (no commits in >30 days) but haven't been merged yet.
Do not delete any unmerged branches.
