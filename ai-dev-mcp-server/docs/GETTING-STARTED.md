# Getting started in five minutes

1. Connect the MCP server to your client and mount the repository you want to change.
2. Call `begin_task` with a short objective and explicit acceptance criteria.
3. Read the returned context pack and implement the smallest safe change.
4. Call `checkpoint_task` with changed files and evidence. If `verify_task` fails, fix the reported gate and checkpoint again.
5. Call `verify_task`, then `complete_task` only after the quality gate passes.

The normal evidence loop is:

```text
begin_task → inspect context → edit → checkpoint_task → verify_task
                                      ↑                  │
                                      └── fix if failed ─┘
                                                         ↓
                                                   complete_task
```

Keep the task bounded. A failed verification is useful evidence, not a completion state: preserve the failure, make the fix, and verify the new source state.
