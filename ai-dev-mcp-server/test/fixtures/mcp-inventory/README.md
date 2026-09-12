# `list_mcp_servers` fixture project

A repository whose agents are wired up the way a real one drifts into: the same
server declared three times with two different definitions, a token referenced
through the environment in one client and prompted for in another, an internal
endpoint still on plain HTTP, a server that starts through a shell, and one
entry nobody finished. No credential is written out here on purpose — the
cleartext-secret cases are built in a temporary directory by
`src/core/mcp-inventory.test.mjs`, so this tree stays safe to copy.
