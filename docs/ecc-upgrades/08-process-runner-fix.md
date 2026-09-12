# 08. Исправление гонки в `process-runner.mjs` (`exit` → `close`)

**Зависимости:** нет. Рекомендуется применить первым: без него тесты изредка падают.

## Что было

При прогоне полного `node --test` на копии `ai-dev-system` тест
`frontend-product-tools.test.mjs` иногда падал (`"rejected"` вместо
`"frontend_design_system_approved"`). Причина оказалась не в frontend-коде:
`runProcess` резолвил результат по событию `exit` дочернего процесса, а `exit` может сработать
раньше, чем stdout/stderr дочитаны до конца. Под нагрузкой вывод `git status` приходил
усечённым, git-фингерпринт состояния проекта получался другим, и верификация отклоняла
задачу как «изменённую после проверки». Это же затрагивает любые ограниченные по размеру
выводы команд (`bounded output`) в `verify_task`.

## Исправление

`close` гарантирует, что оба потока закрыты и все чанки доставлены. Плюс регрессионный тест,
который печатает большой объём и завершает процесс сразу.

```diff
diff --git a/ai-dev-mcp-server/src/core/process-runner.mjs b/ai-dev-mcp-server/src/core/process-runner.mjs
index 4665e1c..4f20dc2 100644
--- a/ai-dev-mcp-server/src/core/process-runner.mjs
+++ b/ai-dev-mcp-server/src/core/process-runner.mjs
@@ -200,9 +200,13 @@ export async function runProcess({
   }, Math.max(1, timeoutMs));
   timeout.unref?.();
 
+  // "close" (not "exit") guarantees stdout/stderr have been fully drained:
+  // "exit" can fire while the last chunks are still in flight, which made
+  // bounded output (and git status based fingerprints) silently incomplete
+  // under load.
   const result = await new Promise((resolve, reject) => {
     child.once("error", reject);
-    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
+    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
   }).finally(() => clearTimeout(timeout));
 
   return {
```

```diff
diff --git a/ai-dev-mcp-server/src/core/process-runner.test.mjs b/ai-dev-mcp-server/src/core/process-runner.test.mjs
index a0260f2..812ff23 100644
--- a/ai-dev-mcp-server/src/core/process-runner.test.mjs
+++ b/ai-dev-mcp-server/src/core/process-runner.test.mjs
@@ -74,3 +74,18 @@ test("pnpm adapters expose bundled Node and disable dependency auto-install", ()
   );
   assert.equal(environment.pnpm_config_verify_deps_before_run, "false");
 });
+
+test("runProcess captures the complete output of a child that exits right after a large write", async () => {
+  const script = "const chunk = 'x'.repeat(1024); for (let i = 0; i < 300; i += 1) process.stdout.write(chunk); process.stdout.write('END\\n');";
+  for (let attempt = 0; attempt < 5; attempt += 1) {
+    const result = await runProcess({
+      executable: process.execPath,
+      args: ["-e", script],
+      cwd: process.cwd(),
+      timeoutMs: 10000
+    });
+    assert.equal(result.ok, true);
+    assert.equal(result.stdout.length, 300 * 1024 + 4, `attempt ${attempt}: output was cut before the child closed its streams`);
+    assert.ok(result.stdout.endsWith("END\n"));
+  }
+});
```

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/process-runner.test.mjs
for i in 1 2 3 4 5; do node --test src/frontend-product-tools.test.mjs || break; done
```

На копии после исправления 5 прогонов подряд прошли чисто.
