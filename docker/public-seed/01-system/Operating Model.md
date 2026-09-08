# Operating Model

This system follows a simple principle: the agent should receive less irrelevant context and more precise context.

## Layer roles

## 1. Knowledge

Knowledge answers: "What is true in this project or system?"

Examples:

- architecture;
- stack;
- business logic;
- API contracts;
- design system;
- test rules;
- deployment;
- security constraints.

## 2. Rules

Rules answer: "How should the agent work?"

Examples:

- preserve existing architecture;
- read the project before editing;
- run checks;
- reuse existing components;
- do not invent APIs;
- record risks.

## 3. Skills

Skills answer: "How should a class of tasks be performed?"

Examples:

- feature-builder;
- bugfix-investigator;
- code-reviewer;
- frontend-polisher;
- github;
- figma;
- notion;
- slack.

## 4. MCP

MCP answers: "How does the agent access knowledge and tools?"

MCP capabilities:

- search the knowledge base;
- read specific notes;
- find relevant skills;
- read a specific `SKILL.md`;
- recommend skills for a task;
- update the index.

## Skill policy

Do not keep all 3,000+ skills active at once.

Preferred approach:

- use no more than three routed skills per task;
- keep the large integration library in the registry;
- let the agent find the relevant skill through MCP and read only that skill.
