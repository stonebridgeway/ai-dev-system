const PROJECT_QA_CONFIG_KEYS = new Set([
  "dev_command", "app_subdir", "url", "routes", "viewports", "scenarios", "required_states",
  "check_anti_slop", "check_accessibility_axe", "check_visual_regression", "max_pixel_diff_ratio",
  "allowed_http_errors", "server_ready_timeout_ms", "navigation_timeout_ms"
]);

export function filterProjectQaConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Frontend QA config must be a JSON object.");
  }
  return {
    config: Object.fromEntries(Object.entries(value).filter(([key]) => PROJECT_QA_CONFIG_KEYS.has(key))),
    ignoredKeys: Object.keys(value).filter((key) => !PROJECT_QA_CONFIG_KEYS.has(key))
  };
}
