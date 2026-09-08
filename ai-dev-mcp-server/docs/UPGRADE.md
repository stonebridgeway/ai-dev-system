# Upgrade guide

## Docker image and volume

Rebuild or pull the new image, then restart the container. The seed is synchronized into an existing runtime volume by the seed-sync step; user knowledge, task records, indexes, and artifacts remain in the volume.

## Runtime home migration

When moving from the old `~/.codex` layout, copy only the supported AI Dev state into `~/.ai-dev`. Keep a backup of the old directory, run `npm run doctor`, and inspect the reported paths before deleting anything.

## Compatibility profile

The default `AI_DEV_TOOL_PROFILE=core` is the compact grouped surface. Set `AI_DEV_TOOL_PROFILE=full` while migrating clients that call legacy tool names, then move calls to grouped actions when convenient.
