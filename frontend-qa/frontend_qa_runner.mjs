import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import AxeBuilder from "@axe-core/playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { parseSafeCommand } from "../ai-dev-mcp-server/src/core/command-policy.mjs";
import {
  buildSpawnEnvironment,
  resolveSpawnInvocation
} from "../ai-dev-mcp-server/src/core/process-runner.mjs";

const rootRequire = createRequire(import.meta.url);

function nowIsoForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function truncate(value, max = 400) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function safeRouteName(route) {
  return String(route || "root")
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "root";
}

function safeProjectPath(projectRoot, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe project-relative path: ${relativePath}`);
  }
  const target = path.resolve(projectRoot, normalized);
  const rel = path.relative(projectRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return target;
}

function pathIsInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeWorkingDirectory(projectRoot, appSubdir) {
  if (!appSubdir) return projectRoot;
  const target = safeProjectPath(projectRoot, appSubdir);
  return target;
}

function artifactDirectory(projectRoot, options, runId) {
  if (options.artifact_dir) {
    const allowedRoot = String(process.env.AI_DEV_FRONTEND_QA_ARTIFACT_ROOT || "").trim();
    if (!allowedRoot) throw new Error("System artifact root is not configured.");
    const target = path.resolve(String(options.artifact_dir));
    if (!pathIsInside(allowedRoot, target)) {
      throw new Error(`Artifact directory escapes the configured system root: ${target}`);
    }
    return target;
  }
  return safeProjectPath(projectRoot, options.screenshot_dir || `.ai-dev/frontend-qa/${runId}`);
}

function baselineDirectory(projectRoot, options) {
  const configured = String(options.visual_baseline_dir || ".ai-dev/frontend-qa-baselines").trim();
  if (!path.isAbsolute(configured)) return safeProjectPath(projectRoot, configured);
  const target = path.resolve(configured);
  const allowedRoot = String(process.env.AI_DEV_FRONTEND_QA_ARTIFACT_ROOT || "").trim();
  if (!pathIsInside(projectRoot, target) && (!allowedRoot || !pathIsInside(allowedRoot, target))) {
    throw new Error(`Visual baseline directory is outside approved roots: ${target}`);
  }
  return target;
}

function displayArtifactPath(projectRoot, filePath) {
  if (pathIsInside(projectRoot, filePath)) {
    return path.relative(projectRoot, filePath).replaceAll("\\", "/");
  }
  return path.resolve(filePath);
}

function loadPlaywright(projectRoot) {
  const errors = [];
  const candidates = [
    { name: "project", require: createRequire(path.join(projectRoot, "package.json")) },
    { name: "runner", require: rootRequire }
  ];

  for (const candidate of candidates) {
    try {
      return {
        source: candidate.name,
        module: candidate.require("playwright")
      };
    } catch (err) {
      errors.push(`${candidate.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { source: "", module: null, errors };
}

function requestUrl(baseUrl, route) {
  const raw = String(route || "/");
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = raw.startsWith("/") ? raw : `/${raw}`;
  return `${base}${suffix}`;
}

function defaultViewports(viewports) {
  const provided = asArray(viewports).filter((item) => item && typeof item === "object");
  if (provided.length) {
    return provided.map((item, index) => ({
      name: String(item.name || `viewport-${index + 1}`),
      width: Math.max(200, Math.min(Number(item.width) || 1280, 3840)),
      height: Math.max(200, Math.min(Number(item.height) || 800, 2400))
    }));
  }
  return [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 }
  ];
}

function scenarioRoutes(scenarios) {
  return asArray(scenarios)
    .filter((scenario) => scenario && typeof scenario === "object")
    .map((scenario) => String(scenario.route || "/"))
    .filter(Boolean);
}

function scenariosForRoute(scenarios, route) {
  return asArray(scenarios)
    .filter((scenario) => scenario && typeof scenario === "object")
    .filter((scenario) => String(scenario.route || "/") === String(route));
}

function actionSelector(action) {
  const selector = String(action.selector || "").trim();
  if (!selector) throw new Error(`Scenario action '${action.action || "unknown"}' requires selector.`);
  return selector;
}

async function executeScenarioAction(page, action, defaultTimeoutMs) {
  const kind = String(action.action || "").trim().toLowerCase();
  const timeout = Math.max(100, Math.min(Number(action.timeout_ms) || defaultTimeoutMs, 120000));
  const selector = ["wait", "expect_url"].includes(kind) ? "" : actionSelector(action);
  if (kind === "click") await page.locator(selector).click({ timeout });
  else if (kind === "fill") await page.locator(selector).fill(String(action.value ?? ""), { timeout });
  else if (kind === "press") await page.locator(selector).press(String(action.key || "Enter"), { timeout });
  else if (kind === "check") await page.locator(selector).check({ timeout });
  else if (kind === "uncheck") await page.locator(selector).uncheck({ timeout });
  else if (kind === "select") await page.locator(selector).selectOption(action.value, { timeout });
  else if (kind === "hover") await page.locator(selector).hover({ timeout });
  else if (kind === "wait_for") await page.locator(selector).waitFor({ state: String(action.state || "visible"), timeout });
  else if (kind === "wait") await page.waitForTimeout(Math.max(0, Math.min(Number(action.ms) || 250, 10000)));
  else if (kind === "expect_visible") await page.locator(selector).waitFor({ state: "visible", timeout });
  else if (kind === "expect_text") {
    const actual = await page.locator(selector).innerText({ timeout });
    const expected = String(action.text ?? action.value ?? "");
    const matches = action.exact ? actual.trim() === expected : actual.includes(expected);
    if (!matches) throw new Error(`Expected text '${expected}' in '${selector}', received '${truncate(actual, 300)}'.`);
  } else if (kind === "expect_url") {
    const expected = String(action.contains ?? action.value ?? "");
    await page.waitForURL((url) => url.toString().includes(expected), { timeout });
  } else {
    throw new Error(`Unsupported scenario action: ${kind || "missing"}`);
  }
}

async function runScenarios(page, scenarios, route, timeoutMs, onScenarioComplete = null) {
  const output = [];
  for (const scenario of scenariosForRoute(scenarios, route)) {
    const scenarioResult = {
      name: String(scenario.name || `scenario-${output.length + 1}`),
      state: String(scenario.state || scenario.name || `state-${output.length + 1}`),
      status: "passed",
      actions: [],
      screenshot: "",
      visual: null,
      overflow: null,
      accessibility_findings: [],
      axe_findings: [],
      anti_slop_findings: []
    };
    for (const [index, action] of asArray(scenario.actions).entries()) {
      const actionResult = {
        index: index + 1,
        action: String(action?.action || ""),
        selector: String(action?.selector || ""),
        status: "passed"
      };
      try {
        await executeScenarioAction(page, action || {}, timeoutMs);
      } catch (error) {
        actionResult.status = "failed";
        actionResult.error = truncate(error instanceof Error ? error.message : String(error), 1000);
        scenarioResult.status = "failed";
        scenarioResult.actions.push(actionResult);
        break;
      }
      scenarioResult.actions.push(actionResult);
    }
    if (typeof onScenarioComplete === "function") {
      try {
        await onScenarioComplete({ scenario, result: scenarioResult });
      } catch (error) {
        scenarioResult.status = "failed";
        scenarioResult.capture_error = truncate(
          error instanceof Error ? error.message : String(error),
          1000
        );
      }
    }
    output.push(scenarioResult);
  }
  return output;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOk(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAnyUrl(urls, timeoutMs) {
  const started = Date.now();
  const candidates = urls.filter(Boolean);
  while (Date.now() - started < timeoutMs) {
    for (const url of candidates) {
      if (await fetchOk(url)) return url;
    }
    await wait(500);
  }
  return "";
}

function inferCandidateUrls(devCommand, explicitUrl) {
  if (explicitUrl) return [explicitUrl];
  const command = String(devCommand || "").toLowerCase();
  const urls = [];
  const portMatch = command.match(/(?:--port|-p)\s+(\d{2,5})/);
  if (portMatch) urls.push(`http://127.0.0.1:${portMatch[1]}`);
  if (/vite|5173/.test(command)) urls.push("http://127.0.0.1:5173");
  if (/next|3000/.test(command)) urls.push("http://127.0.0.1:3000");
  if (/astro|4321/.test(command)) urls.push("http://127.0.0.1:4321");
  urls.push("http://127.0.0.1:5173", "http://127.0.0.1:3000", "http://127.0.0.1:4173");
  return [...new Set(urls)];
}

async function startDevServer(command, cwd) {
  const parsed = parseSafeCommand(command, { purpose: "development" });
  const invocation = await resolveSpawnInvocation(parsed.executable, parsed.args);
  const child = spawn(invocation.executable, invocation.args, {
    cwd,
    env: buildSpawnEnvironment(invocation),
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  const push = (stream, chunk) => {
    logs.push({ stream, text: truncate(chunk.toString(), 1200) });
    while (logs.length > 40) logs.shift();
  };
  child.stdout.on("data", (chunk) => push("stdout", chunk));
  child.stderr.on("data", (chunk) => push("stderr", chunk));
  child.on("error", (error) => push("process", error.message));
  return { child, logs, command: parsed, invocation };
}

async function stopDevServer(server) {
  if (!server?.child || server.child.killed) return;
  if (process.platform === "win32" && Number.isInteger(server.child.pid)) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(server.child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", resolve);
      killer.on("close", resolve);
    });
    return;
  }
  server.child.kill("SIGTERM");
  await wait(800);
  if (!server.child.killed) server.child.kill("SIGKILL");
}

function networkFailureAllowed(failure, rules) {
  if (!failure || failure.kind !== "http") return false;
  return asArray(rules).some((rule) => {
    if (!rule || typeof rule !== "object") return false;
    const expectedStatus = Number(rule.status || 0);
    const pattern = String(rule.url_pattern || "").trim();
    return expectedStatus === Number(failure.status || 0) && pattern && String(failure.url || "").includes(pattern);
  });
}

function blockingNetworkFailures(item) {
  return item.network_failures.filter((failure) => !failure.allowed);
}

async function collectOverflow(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const docOverflow = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) - viewportWidth;
    const offenders = [];
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.right > viewportWidth + 1 || rect.left < -1) {
        offenders.push({
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          className: String(element.className || "").slice(0, 120),
          text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        });
      }
      if (offenders.length >= 20) break;
    }
    return {
      document_overflow_px: Math.max(0, Math.round(docOverflow)),
      offenders
    };
  });
}

async function collectAccessibilityBasics(page) {
  return page.evaluate(() => {
    const findings = [];
    const textOf = (element) => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const cssEscape = (value) => (
      window.CSS?.escape
        ? window.CSS.escape(value)
        : String(value).replace(/["\\]/g, "\\$&")
    );
    const labelledByText = (element) => String(element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map(textOf)
      .filter(Boolean)
      .join(" ");
    const descendantName = (element) => {
      const named = element.querySelector("img[alt], [aria-label], svg title");
      if (!named) return "";
      return String(
        named.getAttribute?.("alt") ||
        named.getAttribute?.("aria-label") ||
        named.textContent ||
        ""
      ).trim();
    };
    const nameOf = (element) => (
      element.getAttribute("aria-label") ||
      labelledByText(element) ||
      element.getAttribute("title") ||
      textOf(element) ||
      descendantName(element) ||
      ""
    ).trim();

    for (const button of Array.from(document.querySelectorAll("button"))) {
      if (!nameOf(button)) findings.push({ type: "button_missing_name", selector: "button", text: "" });
    }
    for (const link of Array.from(document.querySelectorAll("a[href]"))) {
      if (!nameOf(link)) findings.push({ type: "link_missing_name", selector: "a[href]", text: "" });
    }
    for (const input of Array.from(document.querySelectorAll("input, textarea, select"))) {
      const id = input.id;
      const hasLabel = Boolean(
        input.getAttribute("aria-label") ||
        input.getAttribute("aria-labelledby") ||
        (id && document.querySelector(`label[for="${cssEscape(id)}"]`)) ||
        input.closest("label")
      );
      if (!hasLabel && input.getAttribute("type") !== "hidden") {
        findings.push({
          type: "control_missing_label",
          selector: input.tagName.toLowerCase(),
          text: input.getAttribute("name") || input.getAttribute("placeholder") || ""
        });
      }
    }
    for (const img of Array.from(document.querySelectorAll("img"))) {
      if (!img.hasAttribute("alt")) {
        findings.push({ type: "image_missing_alt", selector: "img", text: img.getAttribute("src") || "" });
      }
    }
    return findings.slice(0, 50);
  });
}

async function collectAxeFindings(page) {
  const analysis = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return analysis.violations.slice(0, 50).map((violation) => ({
    id: violation.id,
    impact: violation.impact || "unknown",
    help: violation.help,
    help_url: violation.helpUrl,
    nodes: violation.nodes.slice(0, 10).map((node) => ({
      target: node.target,
      html: truncate(node.html, 500),
      summary: truncate(node.failureSummary, 800)
    }))
  }));
}

async function collectAntiSlopFindings(page, exceptions = []) {
  const waivedRules = new Set(asArray(exceptions).map((item) => (
    typeof item === "string" ? item : item?.rule_id
  )).filter(Boolean));
  const findings = await page.evaluate(() => {
    const output = [];
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 8 &&
        rect.height > 8;
    };
    const all = Array.from(document.querySelectorAll("body *")).filter(visible);
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const samples = (elements, limit = 5) => elements.slice(0, limit).map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      className: String(element.className || "").slice(0, 120),
      text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
    }));

    const roundedSurfaces = all.filter((element) => {
      const style = window.getComputedStyle(element);
      const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      const hasSurface = style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
        style.boxShadow !== "none" ||
        style.borderTopWidth !== "0px";
      return radius >= 16 && hasSurface && element.children.length > 0;
    });
    if (roundedSurfaces.length >= 8) {
      output.push({
        rule_id: "card-soup",
        severity: "block",
        message: `${roundedSurfaces.length} rounded surface containers suggest card soup.`,
        evidence: samples(roundedSurfaces)
      });
    }

    const firstSection = document.querySelector("main > section, body > section, main");
    if (firstSection && visible(firstSection)) {
      const rect = firstSection.getBoundingClientRect();
      const media = firstSection.querySelector("img, video, canvas, picture, iframe, [data-product-preview]");
      const controls = firstSection.querySelectorAll("button, a[href], input, select, textarea").length;
      if (rect.height >= window.innerHeight * 0.9 && !media && controls <= 1) {
        output.push({
          rule_id: "empty-hero",
          severity: "block",
          message: "The first product region consumes almost a full viewport without product media or a usable workflow.",
          evidence: samples([firstSection], 1)
        });
      }
    }

    const gradientElements = all.filter((element) => {
      const image = window.getComputedStyle(element).backgroundImage;
      if (!/gradient/i.test(image)) return false;
      const colors = [...image.matchAll(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/gi)]
        .map((match) => match.slice(1, 4).map(Number));
      return colors.some(([red, green, blue]) => (
        red >= 80 && blue >= 100 && green <= Math.min(red, blue) * 0.8
      ));
    });
    if (gradientElements.length) {
      output.push({
        rule_id: "purple-gradient",
        severity: "block",
        message: "A purple or blue-purple gradient needs explicit product justification.",
        evidence: samples(gradientElements)
      });
    }

    const glass = all.filter((element) => {
      const style = window.getComputedStyle(element);
      const standard = String(style.backdropFilter || "");
      const webkit = String(style.webkitBackdropFilter || "");
      return (standard && standard !== "none") || (webkit && webkit !== "none");
    });
    if (glass.length >= 2) {
      output.push({
        rule_id: "glassmorphism",
        severity: "block",
        message: `${glass.length} visible elements use backdrop blur or filtering.`,
        evidence: samples(glass)
      });
    }

    const decorative = all.filter((element) => (
      /(?:^|[-_])(orb|blob|bokeh|glow)(?:$|[-_])/i.test(`${element.id} ${element.className}`)
    ));
    if (decorative.length) {
      output.push({
        rule_id: "decorative-orbs",
        severity: "block",
        message: "Decorative orb, blob, bokeh, or glow elements were detected.",
        evidence: samples(decorative)
      });
    }

    const metricClaims = Array.from(document.querySelectorAll(
      "[data-metric], .metric, .stat, [class*='metric'], [class*='stat']"
    )).filter(visible).filter((element) => /(?:\d[\d,.]*%|\d[\d,.]*\+|\$\s*\d)/.test(element.textContent || ""));
    const unsourcedMetrics = metricClaims.filter((element) => (
      !element.hasAttribute("data-source") &&
      !element.closest("[data-source]") &&
      !element.querySelector("cite, [data-metric-source]")
    ));
    if (unsourcedMetrics.length) {
      output.push({
        rule_id: "fabricated-metrics",
        severity: "block",
        message: "Metric-like product claims have no machine-visible source annotation.",
        evidence: samples(unsourcedMetrics)
      });
    }

    const genericPhrases = [
      "revolutionize your",
      "supercharge your",
      "unlock the power",
      "take your business to the next level",
      "all-in-one platform",
      "seamlessly transform"
    ].filter((phrase) => text.toLowerCase().includes(phrase));
    if (genericPhrases.length) {
      output.push({
        rule_id: "generic-saas-copy",
        severity: "block",
        message: `Generic SaaS copy detected: ${genericPhrases.join(", ")}.`,
        evidence: genericPhrases
      });
    }

    const excessivelyRounded = all.filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      const circle = Math.abs(rect.width - rect.height) < 2 && radius >= rect.width / 2;
      return radius >= 20 && !circle && rect.width >= 80 && rect.height >= 32;
    });
    if (excessivelyRounded.length >= 8) {
      output.push({
        rule_id: "excessive-rounding",
        severity: "block",
        message: `${excessivelyRounded.length} unrelated visible elements use large radii.`,
        evidence: samples(excessivelyRounded)
      });
    }

    const animated = all.filter((element) => {
      const style = window.getComputedStyle(element);
      return style.animationName !== "none" &&
        (style.animationIterationCount === "infinite" || Number.parseFloat(style.animationDuration) > 1);
    });
    if (animated.length >= 4) {
      output.push({
        rule_id: "meaningless-motion",
        severity: "block",
        message: `${animated.length} visible elements have long or infinite animation.`,
        evidence: samples(animated)
      });
    }
    return output;
  });
  return findings.map((finding) => ({
    ...finding,
    waived: waivedRules.has(finding.rule_id)
  }));
}

async function compareVisualScreenshot({
  screenshotPath,
  baselineDir,
  fileName,
  diffDir,
  updateBaseline,
  maxDiffRatio
}) {
  const baselinePath = path.join(baselineDir, fileName);
  await fs.mkdir(baselineDir, { recursive: true });
  if (updateBaseline) {
    await fs.copyFile(screenshotPath, baselinePath);
    return {
      status: "updated",
      passed: true,
      baseline: baselinePath,
      diff_ratio: 0,
      threshold: maxDiffRatio
    };
  }
  const baselineExists = await fs.stat(baselinePath).then((stat) => stat.isFile()).catch(() => false);
  if (!baselineExists) {
    return {
      status: "missing",
      passed: false,
      baseline: baselinePath,
      diff_ratio: null,
      threshold: maxDiffRatio
    };
  }

  const [actualBuffer, baselineBuffer] = await Promise.all([
    fs.readFile(screenshotPath),
    fs.readFile(baselinePath)
  ]);
  const actual = PNG.sync.read(actualBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      status: "changed",
      passed: false,
      baseline: baselinePath,
      dimensions: {
        actual: `${actual.width}x${actual.height}`,
        baseline: `${baseline.width}x${baseline.height}`
      },
      diff_ratio: 1,
      threshold: maxDiffRatio
    };
  }

  const diff = new PNG({ width: actual.width, height: actual.height });
  const changedPixels = pixelmatch(
    actual.data,
    baseline.data,
    diff.data,
    actual.width,
    actual.height,
    { threshold: 0.1, includeAA: false }
  );
  const diffRatio = changedPixels / Math.max(1, actual.width * actual.height);
  let diffPath = "";
  if (changedPixels > 0) {
    await fs.mkdir(diffDir, { recursive: true });
    diffPath = path.join(diffDir, fileName);
    await fs.writeFile(diffPath, PNG.sync.write(diff));
  }
  return {
    status: diffRatio <= maxDiffRatio ? "match" : "changed",
    passed: diffRatio <= maxDiffRatio,
    baseline: baselinePath,
    diff: diffPath,
    changed_pixels: changedPixels,
    diff_ratio: Number(diffRatio.toFixed(6)),
    threshold: maxDiffRatio
  };
}

function summarizeStatus(results, setupWarnings) {
  const hasNavigationFailure = results.some((item) => item.status === "failed");
  const hasConsoleErrors = results.some((item) => item.console_errors.length || item.page_errors.length);
  const hasServerFailures = results.some((item) => blockingNetworkFailures(item).some((failure) => Number(failure.status || 0) >= 500 || failure.kind === "requestfailed"));
  const hasOverflow = results.some((item) => item.overflow?.document_overflow_px > 0 || item.overflow?.offenders?.length);
  const hasScenarioFailure = results.some((item) => item.scenarios?.some((scenario) => scenario.status === "failed"));
  const hasAxeBlocker = results.some((item) => item.axe_findings?.some((finding) => ["critical", "serious"].includes(finding.impact)));
  const allVisuals = results.flatMap((item) => [
    item.visual,
    ...(item.scenarios || []).map((scenario) => scenario.visual)
  ]).filter(Boolean);
  const hasVisualRegression = allVisuals.some((visual) => visual.status === "changed" && !visual.passed);
  const hasAntiSlopFinding = results.some((item) => (
    item.anti_slop_findings?.some((finding) => !finding.waived) ||
    item.scenarios?.some((scenario) => scenario.anti_slop_findings?.some((finding) => !finding.waived))
  ));
  if (hasNavigationFailure || hasConsoleErrors || hasServerFailures || hasOverflow || hasScenarioFailure || hasAxeBlocker || hasVisualRegression || hasAntiSlopFinding) return "block";
  const hasWarnings = setupWarnings.length ||
    results.some((item) =>
      blockingNetworkFailures(item).length ||
      item.accessibility_findings.length ||
      item.axe_findings?.length ||
      item.visual?.status === "missing" ||
      item.scenarios?.some((scenario) => scenario.visual?.status === "missing")
    );
  return hasWarnings ? "warn" : "pass";
}

function markdownReport(report) {
  const lines = [
    "# Frontend QA Report",
    "",
    `Generated: ${report.started_at}`,
    `Gate: ${report.gate}`,
    `Project: \`${report.project_path}\``,
    `Base URL: ${report.base_url ? `\`${report.base_url}\`` : "not available"}`,
    "",
    "## Summary",
    "",
    `- Routes checked: ${report.routes.length}`,
    `- Viewports checked: ${report.viewports.map((item) => `${item.name} ${item.width}x${item.height}`).join(", ")}`,
    `- Screenshots: ${report.screenshots.length}`,
    `- Required UI states covered: ${report.state_coverage?.complete ? "yes" : "no"}`,
    `- Unwaived anti-slop findings: ${report.unwaived_anti_slop_findings || 0}`,
    `- Setup warnings: ${report.setup_warnings.length}`,
    `- Playwright source: ${report.playwright_source || "unknown"}`,
    `- Artifact directory: ${report.artifact_dir ? `\`${report.artifact_dir}\`` : "not used"}`,
    `- Visual baseline directory: ${report.visual_baseline_dir ? `\`${report.visual_baseline_dir}\`` : "disabled"}`
  ];

  if (report.setup_warnings.length) {
    lines.push("", "## Setup Warnings", "");
    for (const warning of report.setup_warnings) lines.push(`- ${warning}`);
  }

  lines.push("", "## Findings", "");
  for (const item of report.results) {
    lines.push(`### ${item.route} / ${item.viewport.name}`, "");
    lines.push(`- Status: ${item.status}`);
    if (item.screenshot) lines.push(`- Screenshot: \`${item.screenshot}\``);
    if (item.console_errors.length) lines.push(`- Console errors: ${item.console_errors.length}`);
    if (item.page_errors.length) lines.push(`- Page errors: ${item.page_errors.length}`);
    if (blockingNetworkFailures(item).length) lines.push(`- Network failures: ${blockingNetworkFailures(item).length}`);
    const allowedFailures = item.network_failures.filter((failure) => failure.allowed);
    if (allowedFailures.length) lines.push(`- Allowed HTTP responses: ${allowedFailures.length}`);
    if (item.overflow?.document_overflow_px > 0) lines.push(`- Document overflow: ${item.overflow.document_overflow_px}px`);
    if (item.overflow?.offenders?.length) lines.push(`- Overflow offenders: ${item.overflow.offenders.length}`);
    if (item.accessibility_findings.length) lines.push(`- Basic accessibility findings: ${item.accessibility_findings.length}`);
    if (item.axe_findings?.length) lines.push(`- Axe accessibility findings: ${item.axe_findings.length}`);
    if (item.scenarios?.length) {
      lines.push(`- Interaction scenarios: ${item.scenarios.filter((scenario) => scenario.status === "passed").length}/${item.scenarios.length} passed`);
      for (const scenario of item.scenarios) {
        lines.push(`  - State ${scenario.state}: ${scenario.status}${scenario.screenshot ? `, screenshot \`${scenario.screenshot}\`` : ""}`);
        if (scenario.visual) {
          lines.push(`  - State ${scenario.state} visual comparison: ${scenario.visual.status}${Number.isFinite(scenario.visual.diff_ratio) ? ` (${scenario.visual.diff_ratio})` : ""}`);
        }
      }
    }
    if (item.visual) {
      lines.push(`- Visual comparison: ${item.visual.status}${Number.isFinite(item.visual.diff_ratio) ? ` (${item.visual.diff_ratio})` : ""}`);
      if (item.visual.diff) lines.push(`- Visual diff: \`${item.visual.diff}\``);
    }
    const antiSlopFindings = [
      ...(item.anti_slop_findings || []),
      ...(item.scenarios || []).flatMap((scenario) => scenario.anti_slop_findings || [])
    ];
    if (antiSlopFindings.length) {
      lines.push(`- Anti-slop findings: ${antiSlopFindings.length}`);
      for (const finding of antiSlopFindings) {
        lines.push(`  - ${finding.rule_id}: ${finding.message}${finding.waived ? " (waived)" : ""}`);
      }
    }
    if (!item.console_errors.length && !item.page_errors.length && !item.network_failures.length && !item.overflow?.offenders?.length && !item.accessibility_findings.length && !item.axe_findings?.length && !item.scenarios?.some((scenario) => scenario.status === "failed") && !["changed", "missing"].includes(item.visual?.status) && !antiSlopFindings.some((finding) => !finding.waived)) {
      lines.push("- No blocking findings recorded.");
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

async function frontendQaEnvironmentStatus(options) {
  const projectRoot = path.resolve(String(options.project_path || process.cwd()));
  const workingDirectory = safeWorkingDirectory(projectRoot, String(options.app_subdir || "").trim());
  const playwright = loadPlaywright(workingDirectory);
  if (!playwright.module) {
    return {
      status: "unavailable",
      playwright_available: false,
      playwright_source: "",
      chromium_available: false,
      browser_launch_ok: false,
      errors: playwright.errors
    };
  }

  const executablePath = playwright.module.chromium.executablePath();
  const executable = await fs.stat(executablePath).catch(() => null);
  let browserLaunchOk = false;
  let launchError = "";
  let browser = null;
  if (executable?.isFile()) {
    try {
      browser = await playwright.module.chromium.launch({ headless: true });
      browserLaunchOk = true;
    } catch (err) {
      launchError = err instanceof Error ? err.message : String(err);
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  return {
    status: browserLaunchOk ? "ok" : "degraded",
    playwright_available: true,
    playwright_source: playwright.source,
    axe_available: true,
    visual_regression_available: true,
    chromium_available: Boolean(executable?.isFile()),
    chromium_executable: executablePath,
    browser_launch_ok: browserLaunchOk,
    launch_error: launchError,
    errors: playwright.errors || []
  };
}

async function runFrontendQa(options) {
  const projectRoot = path.resolve(String(options.project_path || ""));
  const stats = await fs.stat(projectRoot).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Project directory does not exist: ${options.project_path}`);
  const workingDirectory = safeWorkingDirectory(projectRoot, String(options.app_subdir || "").trim());
  const workingStats = await fs.stat(workingDirectory).catch(() => null);
  if (!workingStats?.isDirectory()) throw new Error(`Frontend working directory does not exist: ${workingDirectory}`);

  const startedAt = new Date().toISOString();
  const scenarios = asArray(options.scenarios).filter((scenario) => scenario && typeof scenario === "object");
  const configuredRoutes = asArray(options.routes).length ? asArray(options.routes).map(String) : ["/"];
  const routes = [...new Set([...configuredRoutes, ...scenarioRoutes(scenarios)])];
  const viewports = defaultViewports(options.viewports);
  const setupWarnings = [];
  const screenshots = [];
  const runId = nowIsoForPath();
  const screenshotDir = artifactDirectory(projectRoot, options, runId);
  const takeScreenshots = options.take_screenshots !== false;
  const checkConsole = options.check_console !== false;
  const checkOverflow = options.check_overflow !== false;
  const checkAccessibilityBasic = options.check_accessibility_basic !== false;
  const checkAccessibilityAxe = options.check_accessibility_axe !== false;
  const checkAntiSlop = options.check_anti_slop === true;
  const antiSlopExceptions = asArray(options.anti_slop_exceptions);
  const requiredStates = [...new Set(asArray(options.required_states).map((value) => String(value).trim()).filter(Boolean))];
  const checkVisualRegression = takeScreenshots && options.check_visual_regression !== false;
  const visualBaselineDir = checkVisualRegression ? baselineDirectory(projectRoot, options) : "";
  const visualDiffDir = path.join(screenshotDir, "visual-diffs");
  const updateVisualBaselines = options.update_visual_baselines === true;
  const requestedDiffRatio = Number(options.max_pixel_diff_ratio);
  const maxPixelDiffRatio = Math.max(0, Math.min(Number.isFinite(requestedDiffRatio) ? requestedDiffRatio : 0.01, 1));
  const scenarioTimeoutMs = Math.max(500, Math.min(Number(options.scenario_timeout_ms) || 10000, 120000));
  if (!takeScreenshots && options.check_visual_regression !== false) {
    setupWarnings.push("Visual regression was skipped because screenshots are disabled.");
  }

  const playwright = loadPlaywright(workingDirectory);
  if (!playwright.module) {
    return {
      gate: "warn",
      status: "playwright_unavailable",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      project_path: projectRoot,
      working_directory: workingDirectory,
      base_url: options.url || "",
      routes,
      viewports,
      screenshots: [],
      artifact_dir: screenshotDir,
      playwright_source: "",
      setup_warnings: [
        "Playwright package is not available from the project or runner environment.",
        "Install Playwright and Chromium in the AI Dev System frontend-qa runner environment.",
        ...playwright.errors
      ],
      results: [],
      markdown: ""
    };
  }

  let devServer = null;
  let baseUrl = String(options.url || "").trim();
  const devCommand = String(options.dev_command || "").trim();

  if (!baseUrl && options.start_dev_server !== false && devCommand) {
    try {
      devServer = await startDevServer(devCommand, workingDirectory);
      baseUrl = await waitForAnyUrl(inferCandidateUrls(devCommand, ""), Math.max(1000, Math.min(Number(options.server_ready_timeout_ms) || 60000, 180000)));
      if (!baseUrl) {
        setupWarnings.push(`Dev server did not become ready for command: ${devCommand}`);
        setupWarnings.push(...devServer.logs.slice(-8).map((item) => `${item.stream}: ${item.text}`));
      }
    } catch (error) {
      setupWarnings.push(`Dev command was blocked or could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!baseUrl) {
    await stopDevServer(devServer);
    return {
      gate: "warn",
      status: "missing_url",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      project_path: projectRoot,
      working_directory: workingDirectory,
      base_url: "",
      routes,
      viewports,
      screenshots: [],
      artifact_dir: screenshotDir,
      playwright_source: playwright.source,
      setup_warnings: [
        "No URL was provided and no dev server URL could be detected.",
        "Pass `url`, or pass `dev_command` with `start_dev_server: true`."
      ],
      results: [],
      markdown: ""
    };
  }

  if (takeScreenshots) await fs.mkdir(screenshotDir, { recursive: true });

  const results = [];
  let browser = null;
  try {
    browser = await playwright.module.chromium.launch({ headless: true });
    for (const route of routes) {
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        const networkFailures = [];

        if (checkConsole) {
          page.on("console", (message) => {
            if (["error", "warning"].includes(message.type())) {
              consoleErrors.push({ type: message.type(), text: truncate(message.text(), 800) });
            }
          });
          page.on("pageerror", (error) => {
            pageErrors.push({ message: truncate(error.message || String(error), 1200) });
          });
          page.on("requestfailed", (request) => {
            networkFailures.push({
              kind: "requestfailed",
              url: truncate(request.url(), 500),
              method: request.method(),
              failure: request.failure()?.errorText || ""
            });
          });
          page.on("response", (response) => {
            const status = response.status();
            if (status >= 400) {
              const failure = {
                kind: "http",
                url: truncate(response.url(), 500),
                status,
                status_text: response.statusText()
              };
              failure.allowed = networkFailureAllowed(failure, options.allowed_http_errors);
              networkFailures.push(failure);
            }
          });
        }

        const url = requestUrl(baseUrl, route);
        const item = {
          route,
          url,
          viewport,
          status: "passed",
          console_errors: consoleErrors,
          page_errors: pageErrors,
          network_failures: networkFailures,
          overflow: { document_overflow_px: 0, offenders: [] },
          accessibility_findings: [],
          axe_findings: [],
          anti_slop_findings: [],
          scenarios: [],
          visual: null,
          screenshot: ""
        };

        try {
          await page.goto(url, {
            waitUntil: "networkidle",
            timeout: Math.max(5000, Math.min(Number(options.navigation_timeout_ms) || 30000, 120000))
          });
          if (checkOverflow) item.overflow = await collectOverflow(page);
          if (checkAccessibilityBasic) item.accessibility_findings = await collectAccessibilityBasics(page);
          if (checkAccessibilityAxe) item.axe_findings = await collectAxeFindings(page);
          if (checkAntiSlop) {
            item.anti_slop_findings = await collectAntiSlopFindings(page, antiSlopExceptions);
          }

          const captureState = async (stateName) => {
            const fileName = `${safeRouteName(route)}__${safeRouteName(viewport.name)}__${safeRouteName(stateName)}.png`;
            const screenshotPath = path.join(screenshotDir, fileName);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const screenshot = displayArtifactPath(projectRoot, screenshotPath);
            screenshots.push(screenshot);
            let visual = null;
            if (checkVisualRegression) {
              visual = await compareVisualScreenshot({
                screenshotPath,
                baselineDir: visualBaselineDir,
                fileName,
                diffDir: visualDiffDir,
                updateBaseline: updateVisualBaselines,
                maxDiffRatio: maxPixelDiffRatio
              });
              visual.baseline = displayArtifactPath(projectRoot, visual.baseline);
              if (visual.diff) visual.diff = displayArtifactPath(projectRoot, visual.diff);
            }
            return { screenshot, visual };
          };

          if (takeScreenshots) {
            const captured = await captureState("default");
            item.screenshot = captured.screenshot;
            item.visual = captured.visual;
          }

          item.scenarios = await runScenarios(
            page,
            scenarios,
            route,
            scenarioTimeoutMs,
            async ({ scenario, result: scenarioResult }) => {
              if (checkOverflow) scenarioResult.overflow = await collectOverflow(page);
              if (checkAccessibilityBasic) {
                scenarioResult.accessibility_findings = await collectAccessibilityBasics(page);
              }
              if (checkAccessibilityAxe) {
                scenarioResult.axe_findings = await collectAxeFindings(page);
              }
              if (checkAntiSlop) {
                scenarioResult.anti_slop_findings = await collectAntiSlopFindings(
                  page,
                  antiSlopExceptions
                );
              }
              if (takeScreenshots && scenario.capture_screenshot !== false) {
                const captured = await captureState(scenarioResult.state);
                scenarioResult.screenshot = captured.screenshot;
                scenarioResult.visual = captured.visual;
              }
              if (
                scenarioResult.overflow?.document_overflow_px > 0 ||
                scenarioResult.overflow?.offenders?.length ||
                scenarioResult.axe_findings?.some((finding) => ["critical", "serious"].includes(finding.impact)) ||
                scenarioResult.anti_slop_findings?.some((finding) => !finding.waived) ||
                (scenarioResult.visual?.status === "changed" && !scenarioResult.visual?.passed)
              ) {
                scenarioResult.status = "failed";
              }
            }
          );
        } catch (err) {
          item.status = "failed";
          pageErrors.push({ message: truncate(err instanceof Error ? err.message : String(err), 1200) });
        } finally {
          await context.close().catch(() => {});
        }

        results.push(item);
      }
    }
  } catch (err) {
    setupWarnings.push(`Browser launch or QA run failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser?.close().catch(() => {});
    await stopDevServer(devServer);
  }

  for (const item of results) {
    if (
      item.status !== "failed" &&
      (item.console_errors.length ||
        item.page_errors.length ||
        blockingNetworkFailures(item).some((failure) => Number(failure.status || 0) >= 500 || failure.kind === "requestfailed") ||
        item.overflow?.document_overflow_px > 0 ||
        item.overflow?.offenders?.length ||
        item.scenarios?.some((scenario) => scenario.status === "failed") ||
        item.axe_findings?.some((finding) => ["critical", "serious"].includes(finding.impact)) ||
        item.anti_slop_findings?.some((finding) => !finding.waived) ||
        (item.visual?.status === "changed" && !item.visual?.passed))
    ) {
      item.status = "failed";
    } else if (
      item.status !== "failed" &&
      (blockingNetworkFailures(item).length ||
        item.accessibility_findings.length ||
        item.axe_findings?.length ||
        item.visual?.status === "missing" ||
        item.scenarios?.some((scenario) => scenario.visual?.status === "missing"))
    ) {
      item.status = "warn";
    }
  }

  const capturedStates = results.flatMap((item) => [
    ...(item.screenshot ? [{
      route: item.route,
      viewport: item.viewport.name,
      state: "default",
      screenshot: item.screenshot
    }] : []),
    ...(item.scenarios || []).filter((scenario) => scenario.screenshot).map((scenario) => ({
      route: item.route,
      viewport: item.viewport.name,
      state: scenario.state,
      screenshot: scenario.screenshot
    }))
  ]);
  const missingStates = [];
  for (const state of requiredStates) {
    for (const viewport of viewports) {
      if (!capturedStates.some((item) => item.state === state && item.viewport === viewport.name)) {
        missingStates.push({ state, viewport: viewport.name });
      }
    }
  }
  const stateCoverage = {
    required: requiredStates,
    captured: capturedStates,
    missing: missingStates,
    complete: missingStates.length === 0
  };
  const visualComparisons = results.flatMap((item) => [
    item.visual,
    ...(item.scenarios || []).map((scenario) => scenario.visual)
  ]).filter(Boolean);
  const unwaivedAntiSlopFindings = results.reduce((total, item) => (
    total +
    (item.anti_slop_findings || []).filter((finding) => !finding.waived).length +
    (item.scenarios || []).reduce((scenarioTotal, scenario) => (
      scenarioTotal + (scenario.anti_slop_findings || []).filter((finding) => !finding.waived).length
    ), 0)
  ), 0);
  let gate = summarizeStatus(results, setupWarnings);
  if (!stateCoverage.complete) gate = "block";

  const report = {
    gate,
    status: "completed",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    project_path: projectRoot,
    working_directory: workingDirectory,
    loaded_config_path: options.loaded_config_path || "",
    base_url: baseUrl,
    dev_command: devCommand,
    dev_command_policy: devServer ? {
      parsed: devServer.command,
      invocation: devServer.invocation
    } : null,
    routes,
    viewports,
    scenarios: scenarios.map((scenario) => ({
      name: String(scenario.name || ""),
      state: String(scenario.state || scenario.name || ""),
      route: String(scenario.route || "/"),
      actions: asArray(scenario.actions).length
    })),
    required_states: requiredStates,
    state_coverage: stateCoverage,
    anti_slop: {
      enabled: checkAntiSlop,
      exceptions: antiSlopExceptions
    },
    unwaived_anti_slop_findings: unwaivedAntiSlopFindings,
    screenshots,
    artifact_dir: screenshotDir,
    visual_baseline_dir: visualBaselineDir,
    visual_regression: {
      enabled: checkVisualRegression,
      update_baselines: updateVisualBaselines,
      max_pixel_diff_ratio: maxPixelDiffRatio
    },
    visual_baselines_complete: checkVisualRegression &&
      visualComparisons.length > 0 &&
      visualComparisons.every((visual) => ["match", "updated"].includes(visual.status)),
    playwright_source: playwright.source,
    setup_warnings: setupWarnings,
    results
  };
  report.markdown = markdownReport(report);
  return report;
}

async function withProjectConfiguration(input) {
  if (input.load_project_config === false || !input.project_path) return input;
  const projectRoot = path.resolve(String(input.project_path));
  const configuredPath = String(input.config_path || ".ai-dev/frontend-qa.json");
  const configPath = safeProjectPath(projectRoot, configuredPath);
  const configExists = await fs.stat(configPath).then((stat) => stat.isFile()).catch(() => false);
  if (!configExists) return input;
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Frontend QA config must be a JSON object: ${configPath}`);
  }
  return {
    ...parsed,
    ...input,
    project_path: projectRoot,
    loaded_config_path: configPath
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = chunks.join("").trim();
  const rawOptions = input ? JSON.parse(input) : {};
  const options = rawOptions.action === "status"
    ? rawOptions
    : await withProjectConfiguration(rawOptions);
  const result = options.action === "status"
    ? await frontendQaEnvironmentStatus(options)
    : await runFrontendQa(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
