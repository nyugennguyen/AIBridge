---
description: Show AIBridge peers and the status of a dispatched job
argument-hint: [job_id] [peer]
---

Call `bridge_peers` and show each peer's reachability, runtime state and capabilities in a short table.

If arguments were given ($ARGUMENTS), treat them as `job_id` and `peer`, call `bridge_status` for that job and, if it is final, `bridge_result`, and summarize the outcome. Do not wait; this command is a snapshot.
