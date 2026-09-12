import { IGNORED_CHANGE_PATH, collectChangeSet } from "../core/change-hygiene.mjs";
import { COVERAGE_FORMATS, rankCoverageGaps, readCoverageReport, summarizeCoverage } from "../core/coverage-reports.mjs";

/**
 * Coverage gaps: what a change left untested, read out of the report the
 * project's own test run already wrote.
 *
 * @param {{ resolveProjectIdentity: Function, taskStore: { read: Function } }} host
 */
export function createCoverageTools(host) {
  return {
    definitions: [
      {
        name: "coverage_gaps",
        description: "Read the project's coverage report (lcov.info, Istanbul coverage-final.json, a Cobertura or coverage.py XML, or a go test coverprofile) and rank what is not covered, weighing the files this change touched above everything else. Reads a report, never runs one: produce it with the project's own test command first. Read-only. Give project_path or task_id to say which repository to read.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task whose project is read; its change set decides which files rank first." },
            report_path: { type: "string", description: "Report to read, relative to the project. Default: the first conventional path that exists." },
            format: { type: "string", enum: COVERAGE_FORMATS, description: "Only read with report_path, when the file name does not imply the format." },
            base_ref: { type: "string", default: "HEAD", description: "Git ref the change set is taken against; use the branch base (for example main) to include committed work." },
            changed_only: { type: "boolean", default: true, description: "Report only files the change set touched. Ignored when it touched none of the files in the report." },
            limit: { type: "number", default: 20 }
          }
        }
      }
    ],
    handlers: {
      async coverage_gaps(args) {
        const { projectRoot } = await resolveProject(host, args);
        const report = await readCoverageReport(projectRoot, { reportPath: args.report_path, format: args.format });
        if (!report) {
          return {
            project_path: projectRoot,
            status: "no_report",
            report: null,
            gaps: [],
            next_step: args.report_path
              ? `No readable coverage report at ${args.report_path}. Run the project's test command with coverage enabled first.`
              : "No coverage report found. Run the project's test command with coverage enabled (npm test -- --coverage, pytest --cov --cov-report=xml, go test -coverprofile=coverage.out), then call this again."
          };
        }
        const changedFiles = await changedFilesOf(projectRoot, args.base_ref);
        const totals = summarizeCoverage(report.files);
        const ranked = rankCoverageGaps({
          files: report.files,
          changedFiles,
          changedOnly: args.changed_only !== false,
          limit: args.limit
        });
        return {
          project_path: projectRoot,
          status: ranked.gaps.length ? "gaps" : "covered",
          report: { format: report.format, path: report.path, generated_at: report.generated_at },
          totals,
          changed_files: changedFiles.length,
          changed_files_in_report: ranked.changed_files_in_report,
          scope: ranked.scope,
          gaps: ranked.gaps,
          next_step: nextStep(ranked, changedFiles.length, totals)
        };
      }
    },
    readOnly: ["coverage_gaps"]
  };
}

async function resolveProject(host, args) {
  if (args.task_id) {
    const record = await host.taskStore.read(args.task_id);
    return { projectRoot: (await host.resolveProjectIdentity(record.project.path)).project_root, record };
  }
  if (!args.project_path) throw new Error("project_path or task_id is required.");
  return { projectRoot: (await host.resolveProjectIdentity(args.project_path)).project_root, record: null };
}

/** The repository-relative paths of the current change set, without the files this server generates. */
async function changedFilesOf(projectRoot, baseRef) {
  const changeSet = await collectChangeSet(projectRoot, { baseRef: baseRef || "HEAD" });
  return (changeSet.files ?? []).map((file) => file.path).filter((filePath) => !IGNORED_CHANGE_PATH.test(filePath));
}

function nextStep(ranked, changedCount, totals) {
  if (!ranked.gaps.length) {
    return changedCount
      ? "Every line the report covers is covered. Nothing to add for this change."
      : "Nothing uncovered in the report. The change set is empty, so this is the whole project's answer.";
  }
  if (ranked.scope === "project") {
    return changedCount
      ? "None of the changed files appear in the report, so this ranks the whole project. Check that the report is current and covers the changed paths."
      : `The change set is empty, so this ranks the whole project (${totals.line_percent}% of lines covered).`;
  }
  const first = ranked.gaps[0];
  const target = first.uncovered_functions[0];
  return `Start with ${first.file} (${first.line_percent}% of lines, ${first.uncovered_lines} uncovered at ${first.ranges.slice(0, 3).join(", ")})${target ? `: ${target.name} at line ${target.line} runs in no test` : ""}.`;
}
