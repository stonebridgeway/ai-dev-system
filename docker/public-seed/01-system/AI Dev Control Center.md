# AI Dev Control Center

This is the clean local control surface for the containerized AI Dev System.

## Engineering Workflow

1. Mount repositories under `/workspace`.
2. Call `begin_task` with the container path.
3. Load only the routed skills and bounded project context.
4. Implement, verify, and complete the task with machine-readable evidence.

## Privacy Boundary

- Knowledge, task state, search indexes, and artifacts stay in the local Docker volume.
- No password notes or owner project contexts are included in the image.
- The MCP transport is local stdio; no remote listener is enabled.
