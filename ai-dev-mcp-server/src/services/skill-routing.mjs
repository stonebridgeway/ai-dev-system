export function createSkillRoutingService({ callLegacy }) {
  return Object.freeze({
    recommend: (args) => callLegacy("recommend_skills", args),
    read: (args) => callLegacy("read_skill", args)
  });
}
