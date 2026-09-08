import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Run a stdin-driven child with bounded output and a tree-wide hard timeout.
 * Rejects on a non-zero exit so callers can preserve their existing contract.
 */
export function execFileWithInput(command, args, input, {
  cwd,
  timeoutMs = 120000,
  env = {},
  maxOutputBytes = 8 * 1024 * 1024
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const terminateTree = () => {
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            shell: false
          });
          killer.on("error", () => {});
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      terminateTree();
      finish(reject, new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref?.();
    const collect = (append) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminateTree();
        finish(reject, new Error(`Command output exceeded ${maxOutputBytes} bytes: ${command}`));
        return;
      }
      append(chunk.toString());
    };
    child.stdout.on("data", collect((text) => { stdout += text; }));
    child.stderr.on("data", collect((text) => { stderr += text; }));
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(stderr || stdout || `Command failed with exit code ${code}`));
    });
    // A child may exit between the writable check and stdin.end(). Consume EPIPE
    // so a failed worker cannot terminate the MCP process.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
