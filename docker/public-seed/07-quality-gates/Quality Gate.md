# Quality Gate

Перед финальным ответом агент должен по возможности выполнить relevant checks.

## Default checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Adaptation

Команды всегда брать из конкретного проекта:

- README;
- package.json;
- Makefile;
- CI config;
- AGENTS.md.

## If checks cannot run

В финале указать:

- какая проверка не запущена;
- почему;
- какой риск остается.

