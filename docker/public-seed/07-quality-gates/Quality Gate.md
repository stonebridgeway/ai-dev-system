# Quality Gate

Before the final response, the agent should run the relevant checks whenever possible.

## Default checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Adaptation

Always derive commands from the concrete project:

- README;
- package.json;
- Makefile;
- CI configuration;
- AGENTS.md.

## If checks cannot run

In the final response, state:

- which check was not run;
- why it was skipped;
- what residual risk remains.
