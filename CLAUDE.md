## Linear
Read from Linear freely — issues, comments, docs. Don't write to it: no
comments, no issue state changes, no new issues. When work is done, report
the commit hash and the exact verification output. The chat session records
it in Linear.

## MCP server (mcp/)
Runs from `dist/index.js`, not from source. After any change under `mcp/`,
run `npm run build` AND reconnect the server — the running process keeps
the code it was spawned with. Symptom of skipping the reconnect is a tool
schema missing parameters that are plainly present in `mcp/src/`.
