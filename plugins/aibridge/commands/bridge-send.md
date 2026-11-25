---
description: Dispatch a task to an AIBridge worker node and report the result
argument-hint: <peer> <capability> <task description>
---

Follow the aibridge-dispatch skill to send this task to a remote worker.

Arguments: $ARGUMENTS

1. Parse the first word as the peer id and the second as the capability (default capability `investigate`, and call `bridge_peers` to choose a peer if none was given). The rest is the task.
2. Push the current branch and include the branch name and commit sha in the prompt.
3. Call `bridge_dispatch`, then loop `bridge_await` until a final status, then `bridge_result`.
4. Summarize the findings. If dispatch is denied with `approval_required`, stop and ask the user to approve it with the operator CLI.
