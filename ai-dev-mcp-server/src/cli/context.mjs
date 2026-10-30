/**
 * What every `ai-dev` command shares: where the install is, how it talks to
 * the person running it, and the command line clients are given to start it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { EXIT } from "../core/cli-args.mjs";
import { SERVER_ROOT } from "../core/client-connections.mjs";

// The install's root, its CLI, the command line a client config runs and a
// path as a person reads it are the core's: the control tools need them too.
export { CLI_PATH, SERVER_ROOT, localLaunch, tildify } from "../core/client-connections.mjs";

/** The version in this install's package.json. */
export function packageVersion() {
  try {
    return String(JSON.parse(readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * @typedef {object} CliIo
 * @property {(line?: string) => void} out - A line on stdout.
 * @property {(line?: string) => void} err - A line on stderr.
 * @property {NodeJS.WritableStream & { isTTY?: boolean, columns?: number }} stdout
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} [stdin] - What a person types; the menu reads it.
 * @property {NodeJS.ProcessEnv} env
 * @property {boolean} interactive - A person at a terminal can be asked.
 * @property {(question: string, fallback: boolean) => Promise<boolean>} ask - A yes/no
 *   question; the fallback is the answer to a bare Enter, and to anything when nobody can be asked.
 */

let pipeWatched = false;

/**
 * A reader that stops early (`ai-dev clients list | head -3`, a client that
 * went away) closes stdout; the next write is EPIPE, which Node raises as an
 * uncaught error with a stack trace. The output was not wanted any more: stop.
 */
function quietOnClosedPipe(stream) {
  if (stream !== process.stdout || pipeWatched) return;
  pipeWatched = true;
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") throw error;
    process.exit(process.exitCode ?? 0);
  });
}

/**
 * The real terminal, or the streams a test hands in.
 *
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, stdin?: NodeJS.ReadableStream, env?: NodeJS.ProcessEnv, interactive?: boolean }} [streams]
 * @returns {CliIo}
 */
export function createIo({
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
} = {}) {
  quietOnClosedPipe(stdout);
  return {
    stdout,
    stdin,
    env,
    interactive,
    out: (line = "") => stdout.write(`${line}\n`),
    err: (line = "") => stderr.write(`${line}\n`),
    async ask(question, fallback) {
      if (!interactive) return fallback;
      const prompt = readline.createInterface({ input: stdin, output: stdout });
      try {
        const answer = (await prompt.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        if (!answer) return fallback;
        return answer === "y" || answer === "yes" || answer === "д" || answer === "да";
      } catch (error) {
        // Ctrl-C at a question is the same stop as Ctrl-C anywhere else: 130,
        // not a failure with readline's "Aborted with Ctrl+C".
        if (error?.code !== "ABORT_ERR" && error?.name !== "AbortError") throw error;
        stdout.write("\n");
        throw Object.assign(new Error("Stopped with Ctrl-C at a question, before anything was changed."), { exitCode: EXIT.interrupted });
      } finally {
        prompt.close();
      }
    }
  };
}

