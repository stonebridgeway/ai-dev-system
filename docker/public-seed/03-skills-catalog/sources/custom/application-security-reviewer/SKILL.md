---
name: application-security-reviewer
description: Use when Codex must threat-model or review application code, APIs, authentication, authorization, sessions, uploads, webhooks, untrusted input, sensitive data, or security-relevant changes and produce evidence-based actionable findings.
---

# Application Security Reviewer

## Objective

Review the actual changed attack surface, prove exploitability or protection where practical, and prioritize fixes by impact and reachability rather than producing a generic checklist.

## Workflow

1. Read repository rules, architecture, trust boundaries, data classifications, deployment context, and the proposed diff.
2. Identify assets, actors, entry points, privileges, tenant boundaries, external dependencies, and sensitive operations.
3. Trace untrusted data from input through parsing, validation, authorization, storage, rendering, logging, and outbound requests.
4. Review authentication separately from authorization and verify object-level access decisions.
5. Review abuse cases for state changes, retries, concurrency, rate limits, and automation.
6. Validate suspected findings with code paths, tests, or a safe local reproduction.
7. Recommend the narrowest effective remediation and regression coverage.
8. Recheck the final diff for newly exposed data, logs, endpoints, or configuration.

## Review Areas

- broken object-level, function-level, or tenant-level authorization;
- session fixation, token lifetime, logout, rotation, cookie, and CSRF behavior;
- injection into SQL, shell, templates, paths, headers, logs, and interpreters;
- SSRF, unsafe redirects, URL validation, and internal network access;
- file upload type, size, storage path, execution, and access control;
- XSS, unsafe HTML, CSP assumptions, and output encoding;
- mass assignment, unsafe deserialization, and over-broad response serializers;
- webhook signature, replay, timestamp, ordering, and idempotency;
- sensitive data in logs, errors, analytics, caches, browser storage, and exports;
- missing rate limits or abuse controls on expensive and privileged operations.

## Finding Standard

For every actionable finding include:

- severity and confidence;
- affected entry point and code location;
- required attacker position or privilege;
- concrete impact;
- evidence or safe reproduction;
- smallest remediation;
- regression test or verification method.

Separate confirmed findings from hardening suggestions and unanswered questions.

## Verification

Run repository security tests, focused unit/integration tests, and safe static checks when available. Test both allowed and denied paths, cross-user or cross-tenant access, malformed input, replay, and sensitive error handling where relevant.

## Output

Lead with confirmed findings ordered by severity. Then report assumptions, checks run, hardening opportunities, and unverified surfaces.

## Guardrails

- Do not attack production, scan third-party systems, access another user's data, or bypass authorization outside an isolated authorized environment.
- Do not include real secrets, tokens, personal data, or exploit payloads containing sensitive values in reports.
- Do not label theoretical risk as confirmed vulnerability without a reachable path and impact.
- Do not replace existing cryptography, authentication, or authorization libraries with custom implementations.
