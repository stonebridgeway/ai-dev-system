---
name: ar-security-review
description: Use when back-end or front-end code, a dependency manifest or a lockfile changed, when the Stop hook or the guard asks for a security review, or when asked to scan a project for vulnerabilities, malware or leaked secrets and patch them. Runs the ai-dev scanners (npm, pnpm, Yarn and Bun audits, osv-scanner, gitleaks, semgrep, trivy), turns dependency findings into an exact plan with plan_security_fixes, applies it only after the user confirms, verifies with a re-scan, and reviews the changed TypeScript and JavaScript for injection, authorization and secret handling. Triggers in Russian - проверка безопасности, просканировать на уязвимости, залатать уязвимости, малварь, вредоносный пакет, аудит зависимостей.
---

# AR Security Review

## Objective

Close security gaps in any project fast and provably: vulnerable and malicious dependencies, leaked secrets, and insecure changes in back-end and front-end code. Every change is one the user confirmed, and a scan after it shows the finding is gone.

## When It Runs

- The Stop hook reports changed files no security scan has seen.
- A post-edit note says a manifest or lockfile changed.
- The guard refused an install as malware or as a release younger than the quarantine.
- The user asks for a security review, a vulnerability scan, or "is this safe to ship".

## Workflow

1. Scan. Call `run_security_scan` with `project_path` (or `task_id`). Read `status`, `summary` and every scanner's `status`. A `skipped` or `error` scanner means its findings are unknown, not absent: name each one and why. `unchecked` is never clean.
2. Handle malware first. For every finding with `kind: "malware"`, stop other work and tell the user now. After they confirm: replace or remove the package as the plan says, delete `node_modules`, reinstall from the corrected lockfile, and list the credentials to rotate — npm and GitHub tokens, cloud keys, SSH keys, `.env` values — on every machine and CI runner that installed it. Check CI logs for installs in the window the version was live.
3. Plan dependency fixes. Call `plan_security_fixes`. Show the user its table: package, lockfile, installed and target version, action, risk. Read the changelog of every `breaking` item before recommending it; say what it breaks.
4. Confirm, then apply. Only after the user confirms — the whole plan or item by item — run each item's `commands` in its lockfile's directory and apply each `manifest_change` exactly as given. One lockfile at a time.
5. Verify. Run the plan's `verify` steps: a frozen install, the project's build and tests, then `run_security_scan` again. Every applied item must be gone. If a build or test fails, revert that item (restore the manifest and lockfile from git), report it, and keep the rest.
6. Review the changed code. For the back-end and front-end files this task changed (`git diff`), walk the checklist below. Fix confirmed issues in the code with a test that fails before the fix.
7. Record. In a task, pass `record_checkpoint: true` to the scan and the plan, and state the remaining risk in the checkpoint.

## Code Review Checklist

Back end (Node, TypeScript):

- Injection: SQL or NoSQL queries built from strings — use parameters or the query builder; `child_process.exec` with interpolated input — use `execFile` or `spawn` with an argument array; `eval`, `new Function` or `vm` on input; user-controlled paths in `fs` calls without resolving them inside a base directory.
- Access: authorization on every route and handler, per object, not only authentication; input validated at the boundary with a schema (zod, valibot); rate limits on login, reset and OTP endpoints.
- Requests: SSRF on user-supplied URLs — allowlist hosts and refuse private ranges; open redirects; CORS that reflects any origin with credentials; cookies without `HttpOnly`, `Secure` and `SameSite`; CSRF protection for cookie sessions; prototype pollution from merging untrusted objects.

Front end (React, Vue, Next.js, Vite):

- `dangerouslySetInnerHTML`, `innerHTML` or `v-html` with untrusted data — sanitize (DOMPurify) or render text.
- Secrets in the client bundle: anything under `NEXT_PUBLIC_`, `VITE_` or `import.meta.env` is public. Session tokens belong in `HttpOnly` cookies, not `localStorage`.
- A Content-Security-Policy header, and `rel="noopener noreferrer"` on `target="_blank"`.

Secrets and supply chain:

- A secret found in code or history is rotated, then removed; deleting the line alone is not a fix.
- The lockfile is committed; CI installs with `npm ci` or `--frozen-lockfile`; no `latest` or `*` in a production manifest.

## Hardening Suggestions

Propose these once per project; apply them only with the user's confirmation:

- npm 11 and later: `min-release-age=7` in `.npmrc` (days).
- pnpm 10.16 and later: `minimumReleaseAge: 10080` (minutes) and an `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml`.
- CI: pin third-party actions by commit SHA, and do not expose secrets to the install step.
- Keep the scanners themselves pinned: a security tool is a supply-chain target too, as Trivy's compromised v0.69.4 release in March 2026 showed.

## Output

Report in this order: which scanners ran and which did not, with the reason; malware found and what was done about it; the plan and which items were applied after confirmation; the verification — install, build, tests, and the scan's findings before and after; code review findings fixed and remaining; credentials that must be rotated. Say what could not be checked instead of implying it was.

## Guardrails

- Do not install, update or remove any package the user has not confirmed. The command policy asks too; never work around it.
- Never print a secret's value: name the file, the line and the rule.
- Never read `skipped`, `error` or `unchecked` as clean.
- Do not run `npm audit fix --force`, delete a lockfile to clear an advisory, or take a major upgrade without its changelog read and the user's confirmation.
- Do not disable the guard, add to `allow_commands` or set `security_review_on_stop` to `off` to get past a refusal; ask the user.
- Malware is an incident, not a version bump: removal, reinstall and rotation, every time.
