# Skill authoring guide

A local skill lives under `03-skills-catalog/sources/custom/<skill-name>/SKILL.md`. Give it a stable lowercase name, a precise trigger description, an actionable procedure, completion criteria, and an evidence example. Link to the MCP tools it expects the agent to call.

Use frontmatter with `name` and `description`. Keep instructions scoped: explain when the skill applies, what it must inspect, what it may change, and what it must report. Avoid generic advice that cannot be checked.

After adding or changing a skill:

```bash
npm run skills:ensure-index
npm run test:legacy
```

The indexer records taxonomy, quality metadata, and content hashes. Update routing eval cases with both English and Russian examples when the skill should be discoverable from both languages.
