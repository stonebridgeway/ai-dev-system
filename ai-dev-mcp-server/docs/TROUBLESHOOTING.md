# Troubleshooting and FAQ

## The server is not visible in the client

Check the client command, the working directory, and the stderr log. Start with `npm run protocol:smoke`; it validates the MCP handshake and tool listing without a GUI client.

## Startup times out

Use the local Node server first and inspect `npm run doctor`. A Docker cold start also needs the image, the runtime volume, and a mounted project path. Do not increase timeouts before checking which prerequisite is missing.

## A command is rejected

The command policy is intentional. Use an allowed package script or a repository-native verification command. Never bypass the policy to make a failing check appear green.

## Playwright or Python is unavailable

Frontend QA reports a blocking setup failure when it cannot run browser checks. Install the runner's Playwright/Chromium prerequisites. Python is optional for the legacy dense or UI/UX compatibility paths and is not a requirement for core MCP operation.

## `.ai-dev` files conflict

Keep user-authored files, compare generated changes, and rerun the project bootstrap with overwrite disabled. Task context is disposable; project rules and quality-gate files require review before replacement.
