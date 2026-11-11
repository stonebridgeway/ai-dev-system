import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTAINER_MODELS,
  CONTAINER_MODEL_DIR,
  CONTAINER_STATE_ROOT,
  CONTAINER_WORKSPACE,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_DOCKER_VOLUME,
  checkModelFolder,
  dataMount,
  dataPlace,
  dataVolume,
  dockerEntryOptions,
  dockerLaunch,
  dockerRunArgs,
  isDirectDockerEntry,
  missingBindSources,
  modelMount,
  probeStateSharing,
  refusedMount,
  resolveDockerCommand,
  sharesHostState,
  unreadableMounts,
  volumeAtData
} from "./docker-launch.mjs";

const mountsOf = (args) => args.flatMap((argument, index) => (args[index - 1] === "--mount" ? [argument] : []));

test("the entry runs the image with the volume, the host's state and the projects at their own path", () => {
  const args = dockerRunArgs({ image: "img:1", projects: "/home/me/AI-Dev-Projects", state: "/home/me/.ai-dev/state", platform: "linux" });
  assert.deepEqual(args.slice(0, 3), ["run", "-i", "--rm"]);
  assert.equal(args.at(-1), "img:1");
  for (const [flag, value] of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges:true"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.ok(!args.includes("--user"), "the image's user, whatever started the session: the volume has one owner");
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(mountsOf(args), [
    `type=volume,source=${DEFAULT_DOCKER_VOLUME},target=/data`,
    `type=bind,source=/home/me/.ai-dev/state,target=${CONTAINER_STATE_ROOT}`,
    "type=bind,source=/home/me/AI-Dev-Projects,target=/home/me/AI-Dev-Projects"
  ]);
  assert.equal(args[args.indexOf("--env") + 1], `AI_DEV_STATE_ROOT=${CONTAINER_STATE_ROOT}`);
});

test("on Windows the projects are at /workspace, a model folder is read-only at /models, and nothing else is added unasked", () => {
  const windows = dockerRunArgs({ image: "img", projects: "C:\\Users\\me\\AI-Dev-Projects", model: "C:\\models", platform: "win32" });
  assert.deepEqual(mountsOf(windows), [
    `type=volume,source=${DEFAULT_DOCKER_VOLUME},target=/data`,
    `type=bind,source=C:\\Users\\me\\AI-Dev-Projects,target=${CONTAINER_WORKSPACE}`,
    `type=bind,source=C:\\models,target=${CONTAINER_MODELS},readonly`
  ]);
  const bare = dockerRunArgs({ image: "img", platform: "darwin" });
  assert.deepEqual(mountsOf(bare), [`type=volume,source=${DEFAULT_DOCKER_VOLUME},target=/data`]);
  assert.ok(!bare.includes("--user") && !bare.includes("--env"));
  assert.throws(() => dockerRunArgs({ image: "" }), /No image to run/);
  assert.throws(() => dockerRunArgs({ image: "img", projects: "/a,b" }), /comma in its path, which a docker --mount cannot hold/);
  // A double quote outside a quoted CSV field fails every session.
  assert.throws(() => dockerRunArgs({ image: "img", state: '/home/me/"x"/state' }), /double quote in its path, which a docker --mount cannot hold/);
  assert.deepEqual(dockerLaunch({}).args.at(-1), DEFAULT_DOCKER_IMAGE);
  assert.deepEqual(dockerLaunch({ docker: "/usr/local/bin/docker", image: "x" }).command, "/usr/local/bin/docker");
});

test("the host's state is shared where the image's user is the host's: Docker Desktop maps it, Linux needs uid 1000", () => {
  assert.equal(sharesHostState({ platform: "darwin", uid: 501 }), true);
  assert.equal(sharesHostState({ platform: "win32" }), true);
  assert.equal(sharesHostState({ platform: "linux", uid: 1000 }), true);
  assert.equal(sharesHostState({ platform: "linux", uid: 1001 }), false);
  assert.equal(sharesHostState({ platform: "linux", uid: 0 }), false);
});

test("the Docker CLI is named by its full path: a client started from the Dock has no shell PATH", () => {
  const present = (...files) => (file) => files.includes(file);
  assert.equal(resolveDockerCommand({ env: { PATH: "/usr/bin:/bin" }, platform: "linux", exists: present("/usr/bin/docker") }), "/usr/bin/docker");
  // Docker Desktop's own places on macOS, when the shell's PATH does not have it.
  assert.equal(resolveDockerCommand({ env: { PATH: "/usr/bin:/bin" }, platform: "darwin", home: "/Users/me", exists: present("/Users/me/.docker/bin/docker") }), "/Users/me/.docker/bin/docker");
  assert.equal(resolveDockerCommand({ env: { Path: "C:\\Windows" }, platform: "win32", exists: present("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe") }), "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe");
  assert.equal(resolveDockerCommand({ env: { PATH: "relative:/nowhere" }, platform: "linux", exists: () => false }), "docker");
});

test("a model folder is the one above bge-m3-onnx/: the model folder itself is refused", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-docker-launch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "models", "bge-m3-onnx"), { recursive: true });
  assert.equal(checkModelFolder(path.join(root, "models")), path.join(root, "models"));
  assert.throws(() => checkModelFolder(path.join(root, "models", "bge-m3-onnx-missing")), /does not exist/);
  await fs.writeFile(path.join(root, "models", "bge-m3-onnx", "config.json"), "{}");
  assert.throws(() => checkModelFolder(path.join(root, "models", "bge-m3-onnx")), /holds model files itself \(config\.json\)\. Name the folder above it/);
});

test("a model folder whose bge-m3-onnx is a link mounts the link itself, which Docker follows on the host; one that leads nowhere is refused", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-docker-launch-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plain = path.join(root, "plain");
  await fs.mkdir(path.join(plain, "bge-m3-onnx"), { recursive: true });
  assert.deepEqual(modelMount(plain), { source: plain, target: CONTAINER_MODELS }, "a folder holding the model as a folder is mounted as 2.x mounted it");
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  assert.deepEqual(modelMount(empty), { source: empty, target: CONTAINER_MODELS }, "no model yet: the folder, for the model put there later");

  // An absolute link to another disk: read in the container, it would lead nowhere.
  const elsewhere = path.join(root, "disk2", "bge-m3-onnx-real");
  await fs.mkdir(elsewhere, { recursive: true });
  const linked = path.join(root, "linked");
  await fs.mkdir(linked);
  await fs.symlink(elsewhere, path.join(linked, "bge-m3-onnx"));
  const mount = modelMount(linked);
  assert.deepEqual(mount, { source: path.join(linked, "bge-m3-onnx"), target: CONTAINER_MODEL_DIR });
  assert.equal(CONTAINER_MODEL_DIR, "/models/bge-m3-onnx");
  assert.ok(dockerRunArgs({ image: "img", model: mount }).includes(`type=bind,source=${path.join(linked, "bge-m3-onnx")},target=/models/bge-m3-onnx,readonly`));
  assert.ok(dockerRunArgs({ image: "img", model: plain }).includes(`type=bind,source=${plain},target=/models,readonly`), "a folder named as before still means /models");

  const dangling = path.join(root, "dangling");
  await fs.mkdir(dangling);
  await fs.symlink(path.join(root, "unplugged", "bge-m3-onnx"), path.join(dangling, "bge-m3-onnx"));
  assert.throws(() => modelMount(dangling), new RegExp(`^Error: ${path.join(dangling, "bge-m3-onnx").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is a link to .*unplugged.* that leads nowhere here \\(ENOENT\\): connect the disk it leads to, or name another model folder\\. Docker would start no session that mounts it\\.$`));
  // In the image, writing the configs for the host, where the link leads is not to be seen: bootstrap.sh checked it.
  assert.deepEqual(modelMount(dangling, { verify: false }), { source: path.join(dangling, "bge-m3-onnx"), target: CONTAINER_MODEL_DIR });
  // The host's own path rules: a Windows folder joined the Windows way.
  const windows = modelMount("C:\\models", { join: path.win32.join, lstat: () => ({ isSymbolicLink: () => true }), stat: () => ({}) });
  assert.deepEqual(windows, { source: "C:\\models\\bge-m3-onnx", target: CONTAINER_MODEL_DIR });
});

test("a link to another disk is said when the entry is written, and a mount whose folder is gone is found", () => {
  // The link resolves now; its target is on another device than the folder that holds the link.
  const devices = { "/m": 1, "/m/bge-m3-onnx": 2 };
  // A POSIX host's folders, joined as it joins them wherever the test runs.
  const options = { join: path.posix.join, lstat: () => ({ isSymbolicLink: () => true }), stat: (file) => ({ dev: devices[file] }), readlink: () => "/media/disk2/bge-m3-onnx" };
  const mount = modelMount("/m", options);
  assert.deepEqual([mount.source, mount.target], ["/m/bge-m3-onnx", CONTAINER_MODEL_DIR]);
  assert.equal(mount.note, "/m/bge-m3-onnx leads to /media/disk2/bge-m3-onnx, on another disk: every session mounts it from there, so while that disk is away Docker starts no session at all — `ai-dev clients doctor` names the entry then.");
  devices["/m/bge-m3-onnx"] = 1;
  assert.equal(modelMount("/m", options).note, undefined, "the same disk: nothing to say");
  assert.ok(dockerRunArgs({ image: "img", model: mount }).includes("type=bind,source=/m/bge-m3-onnx,target=/models/bge-m3-onnx,readonly"), "the note does not reach the command line");

  const args = ["run", "-i", "--mount", "type=volume,source=data,target=/data", "--mount", "type=bind,source=/here,target=/workspace",
    "--mount", "type=bind,source=/gone/bge-m3-onnx,target=/models/bge-m3-onnx,readonly", "img"];
  assert.deepEqual(missingBindSources(args, knownFs({ "/here": "" })), [{ source: "/gone/bge-m3-onnx", target: "/models/bge-m3-onnx" }]);
  assert.deepEqual(missingBindSources(args, { stat: () => ({}) }), []);
  assert.deepEqual(missingBindSources(undefined), []);
});

// A stat that knows a few paths: "" for one that is there, an error code for one that is not, ENOENT for the rest —
// but the root, which is there, as on every POSIX host: the walk up from a folder that is not there ends at it, and a
// root that is not there is said.
function statOf(known) {
  return (file) => {
    const code = known[file] ?? (file === "/" ? "" : "ENOENT");
    if (code) throw Object.assign(new Error(`${code}: ${file}`), { code });
    return {};
  };
}

// That file system, where this user may write: a folder that is not there is one install makes.
// Its paths are a POSIX host's, read as one reads them wherever the test runs.
const knownFs = (known) => ({ stat: statOf(known), access: () => undefined, path: path.posix });

test("a --mount is read the way Docker's CLI reads it, and only a folder that is not there is missing", () => {
  const gone = (...mount) => missingBindSources(["run", ...mount, "img"], knownFs({ "/here": "" }));
  // Every shape checked against Docker 29 itself: each of these it refuses to start with "bind source path does not exist".
  for (const mount of [
    ["--mount", "type=bind,source=/gone,target=/x,readonly"],
    ["--mount", "type=bind,src=/gone,dst=/x"],
    ["--mount", "type=bind,source=/gone,destination=/x"],
    ["--mount=type=bind,source=/gone,target=/x"],
    ["--mount", "type=bind,\"source=/gone\",target=/x"],
    ["--mount", "TYPE=bind,SOURCE=/gone,TARGET=/x"],
    ["--mount", "type=Bind,source=/gone,target=/x"],
    ["--mount", "type=bind,source=/here,src=/gone,target=/x"],
    ["--mount", "type=bind,source=/gone,target=/y,dst=/x"]
  ]) {
    assert.deepEqual(gone(...mount), [{ source: "/gone", target: "/x" }], mount.join(" "));
  }
  // And these it starts: the last of source and src is the one, a volume is Docker's to make, and so is -v's folder.
  for (const mount of [
    ["--mount", "type=bind,source=/gone,src=/here,target=/x"],
    ["--mount", "type=volume,source=gone,target=/x"],
    ["--mount", "source=gone,target=/x"],
    ["-v", "/gone:/x:ro"],
    ["--volume=/gone:/x"]
  ]) {
    assert.deepEqual(gone(...mount), [], mount.join(" "));
  }
  // A quoted field holds a comma, and a doubled quote stands for one.
  assert.deepEqual(gone("--mount", "type=bind,\"source=/a,b\",target=/x"), [{ source: "/a,b", target: "/x" }]);
  assert.deepEqual(gone("--mount", "type=bind,\"source=/a\"\"b\",target=/x"), [{ source: "/a\"b", target: "/x" }]);
  // A value Docker cannot parse is Docker's to say when the entry runs; nor is it a folder found missing.
  for (const value of ["type=bind,source=\"/gone\",target=/x", "type=bind,\"source=/gone,target=/x", "type=bind,\"source=/gone\"x,target=/x", ""]) {
    assert.deepEqual(gone("--mount", value), [], value);
  }
  assert.deepEqual(gone("--mount"), [], "a --mount with no value");

  // Not there: ENOENT, and ENOTDIR for a file on the way. A folder this user may not look into is the daemon's to judge.
  const spec = (source) => ["run", "--mount", `type=bind,source=${source},target=/x`, "img"];
  const known = knownFs({ "/a/file/x": "ENOTDIR", "/locked/x": "EACCES", "/loop": "ELOOP", "/busy": "EBUSY" });
  assert.deepEqual(missingBindSources(spec("/a/file/x"), known), [{ source: "/a/file/x", target: "/x" }]);
  for (const source of ["/locked/x", "/loop", "/busy"]) assert.deepEqual(missingBindSources(spec(source), known), [], source);

  // A link whose target is away says where it leads; a relative one, from where the link is.
  const link = (target) => ({ lstat: () => ({ isSymbolicLink: () => true }), readlink: () => target, stat: statOf({}), path: path.posix });
  assert.deepEqual(missingBindSources(spec("/m/bge-m3-onnx"), link("/media/disk2/bge-m3-onnx")), [{ source: "/m/bge-m3-onnx", target: "/x", leadsTo: "/media/disk2/bge-m3-onnx" }]);
  assert.equal(missingBindSources(spec("/m/bge-m3-onnx"), link("../disk2/model"))[0].leadsTo, path.posix.resolve("/m", "../disk2/model"));
});

test("a --mount is read as Docker 29 reads it: up to the image, its own CSV lines, bind-create-src, and a value it refuses passed over, not the folders beside it", () => {
  const known = knownFs({ "/here": "" });
  const gone = (...args) => missingBindSources(["run", ...args], known);
  const away = [{ source: "/gone", target: "/x" }];
  // Each of these checked against Docker 29 itself: "bind source path does not exist" for every one.
  for (const value of ["\ntype=bind,source=/gone,target=/x", "\r\n\ntype=bind,source=/gone,target=/x", "type=bind,source=/gone,target=/x\r\n", "type=bind,source=/gone,target=/x\r",
    "type=bind,source=/gone,target=/x,bind-create-src=false", "type=bind,source=/gone,target=/x,bind-create-src,bind-create-src=0", "type=bind,source=/gone,target=/x,readonly=1,consistency=cached,bind-propagation=rprivate,bind-recursive=disabled"]) {
    assert.deepEqual(gone("--mount", value, "img"), away, JSON.stringify(value));
  }
  // Options of every shape before the image; a value is not read again as an option.
  for (const options of [["-it"], ["-e", "A=1"], ["-eA=1"], ["-e=A=1"], ["-ie", "A=1"], ["--env", "--mount"], ["--name=x", "--rm"], ["-v", "/gone:/y"]]) {
    assert.deepEqual(gone(...options, "--mount", "type=bind,source=/gone,target=/x", "img"), away, options.join(" "));
  }
  // Docker makes the source of a bind-create-src mount; a --mount after the image, or after --, is the container's.
  for (const args of [
    ["--mount", "type=bind,source=/gone,target=/x,bind-create-src", "img"],
    ["--mount", "type=bind,source=/gone,target=/x,BIND-CREATE-SRC=true", "img"],
    ["--mount", "type=bind,source=/gone,target=/x,bind-create-src=0,bind-create-src=1", "img"],
    ["-i", "img", "--mount", "type=bind,source=/gone,target=/x"],
    ["--", "img", "--mount=type=bind,source=/gone,target=/x"],
    ["-e", "--mount", "type=bind,source=/gone,target=/x", "img"]
  ]) {
    assert.deepEqual(gone(...args), [], args.join(" "));
  }
  // A value Docker 29's CLI refuses is passed over, and a folder gone beside it is found all the same: Docker 29 refuses
  // the value before it looks at any folder, but the CLIs before it read some such values, and no Docker starts a
  // session without the folder.
  for (const value of ["type=bind,source=/gone,target=/x,bogus=1", "type=bind,source=/gone,target=/x,source", "type=bind, source=/gone,target=/x",
    ",type=bind,source=/gone,target=/x", "type=bind,,source=/gone,target=/x", "type=bind,source=/gone,target=/x,", "type=bind,source=,target=/x",
    "type=bind,source=/gone,target=/x,readonly=yes", "type=bind,source=/gone,target=/x,readonly=TRUE", "type=bind,source=/gone,target=/x,bind-create-src=",
    "type=bind,source=/gone,target=/x,bind-recursive=bogus", "type=bind,source=/gone,target=/x,bind-nonrecursive", "type=bind,source=/gone,target=/x,volume-nocopy",
    "type=bind,source=/gone,target=/x,tmpfs-size=1m", "source=/gone,target=/x,bind-create-src", "\n", ""]) {
    assert.deepEqual(gone("--mount", value, "--mount", "type=bind,source=/gone,target=/y", "img"), [{ source: "/gone", target: "/y" }], JSON.stringify(value));
  }
  assert.deepEqual(gone("--mount=", "--mount", "type=bind,source=/gone,target=/y", "img"), [{ source: "/gone", target: "/y" }], "an empty --mount=");
  // Which values those are, for the doctor to say; one after the image is the container's, and not among them.
  assert.deepEqual(unreadableMounts(["run", "--mount", "type=bind,source=/x,target=/y,bogus=1", "--mount", "type=bind,source=/gone,target=/z", "--mount=", "img", "--mount", "a,b"]), ["type=bind,source=/x,target=/y,bogus=1", ""]);
  assert.deepEqual(unreadableMounts(["run", "-i", "--mount", "\r\ntype=bind,source=/x,target=/y,bind-create-src", "img"]), []);
  assert.deepEqual(unreadableMounts(["run", "-i", "--mount"]), [""], "a --mount with no value");
  // The image is the first argument after the options, whatever the container is told after it.
  assert.equal(dockerEntryOptions(["run", "-i", "--rm", "--mount", "type=volume,source=v,target=/data", "-e", "A=1", "ai-dev-system:3", "ai-dev", "mcp", "--mount", "x"]).image, "ai-dev-system:3");
  assert.equal(dockerEntryOptions(["run", "--mount=type=bind,source=/p,target=/p,bogus=1", "--mount", "type=bind,source=/s,target=/ai-dev-state", "img"]).state, "/s", "a mount it cannot read is passed over");
});

test("a --mount value is trimmed as Docker 29 trims it, and one with a key or a value edged with space inside is not read", () => {
  const gone = (value) => missingBindSources(["run", "--mount", value, "img"], knownFs({}));
  const away = [{ source: "/gone", target: "/x" }];
  // Each checked against Docker 29.8.2, which starts them: what Go's TrimSpace takes off the whole value is no fault.
  for (const value of [" type=bind,source=/gone,target=/x", "\ttype=bind,source=/gone,target=/x", "type=bind,target=/x,source=/gone ",
    " type=bind,source=/gone,target=/x", "\u0085type=bind,source=/gone,target=/x　", " \"type=bind\",\"source=/gone\",\"target=/x\""]) {
    assert.deepEqual(unreadableMounts(["run", "--mount", value, "img"]), [], JSON.stringify(value));
    assert.deepEqual(gone(value), away, JSON.stringify(value));
  }
  // And these it refuses: "option should not have whitespace", "value should not have whitespace"; a BOM is no space.
  for (const value of ["﻿type=bind,source=/gone,target=/x", "type=bind,source=/gone ,target=/x", "type=bind,source= /gone,target=/x",
    "type=bind,source=/gone\r,target=/x", "type=bind,source=/gone,target=/x,readonly =true", "type=bind,source=/gone,target=/x,readonly= true"]) {
    assert.deepEqual(unreadableMounts(["run", "--mount", value, "img"]), [value], JSON.stringify(value));
    assert.deepEqual(gone(value), [], JSON.stringify(value));
  }
});

test("a folder that is not there says why install could not make it again: a link that leads nowhere or a file on the way, or a folder above it this user may not write to", () => {
  // A file system of a few paths — "dir", "file", or "link:<where it leads>", every link leading nowhere — and the
  // folders this user may not write to.
  const io = (paths, locked = []) => {
    const fault = (code, file) => Object.assign(new Error(`${code}: ${file}`), { code });
    return {
      stat: (file) => {
        if (!paths[file] || paths[file].startsWith("link:")) throw fault("ENOENT", file);
        return { isDirectory: () => paths[file] === "dir" };
      },
      lstat: (file) => {
        if (!paths[file]) throw fault("ENOENT", file);
        return { isSymbolicLink: () => paths[file].startsWith("link:") };
      },
      readlink: (file) => paths[file].slice("link:".length),
      access: (file) => {
        if (locked.includes(file)) throw fault("EACCES", file);
      }
    };
  };
  const spec = (source) => ["run", "--mount", `type=bind,source=${source},target=${source}`, "img"];
  const home = { "/": "dir", "/home": "dir", "/home/me": "dir", "/mnt": "dir" };
  // A disk reached through a link, not connected: the link on the way leads nowhere (the review's case 14).
  assert.deepEqual(missingBindSources(spec("/home/me/disk/Projects"), io({ ...home, "/home/me/disk": "link:/media/disk2" })),
    [{ source: "/home/me/disk/Projects", target: "/home/me/disk/Projects", unmakeable: { at: "/home/me/disk", why: "link", leadsTo: path.resolve("/media/disk2") } }]);
  // A disk not connected under a mount point that is root's: as the mount point, or as the folder it would be made in.
  assert.deepEqual(missingBindSources(spec("/mnt/External/Projects"), io({ ...home, "/mnt/External": "dir" }, ["/mnt", "/mnt/External"]))[0].unmakeable, { at: "/mnt/External", why: "write" });
  assert.deepEqual(missingBindSources(spec("/mnt/External/Projects"), io(home, ["/", "/mnt"]))[0].unmakeable, { at: "/mnt", why: "write" });
  // A file where a folder on the way should be.
  assert.deepEqual(missingBindSources(spec("/home/me/notes/Projects"), io({ ...home, "/home/me/notes": "file" }))[0].unmakeable, { at: "/home/me/notes", why: "file" });
  // The nearest folder that is there is this user's: install makes the rest, whatever is above it.
  assert.deepEqual(missingBindSources(spec("/home/me/a/b/Projects"), io(home, ["/", "/home"])), [{ source: "/home/me/a/b/Projects", target: "/home/me/a/b/Projects" }]);
  // The folder itself a link that leads nowhere: where it leads is said, as before.
  assert.deepEqual(missingBindSources(spec("/home/me/Projects"), io({ ...home, "/home/me/Projects": "link:/media/disk2/Projects" }, ["/home/me"])),
    [{ source: "/home/me/Projects", target: "/home/me/Projects", leadsTo: path.resolve("/media/disk2/Projects") }]);
});

test("on Windows a folder on a drive that is not there is one install cannot make: the way up ends at a root that is not there", () => {
  // The review's Windows file system, read with Windows' path rules: C:\ and a user's folders, a junction to E:\ — the
  // drive of a disk that is not connected, whose stat fails ENOENT (ERROR_INVALID_DRIVE and ERROR_PATH_NOT_FOUND are
  // ENOENT in libuv's table) — and a file. No E:\.
  const fault = (code, file) => Object.assign(new Error(`${code}: ${file}`), { code });
  const paths = { "c:\\": "dir", "c:\\users": "dir", "c:\\users\\me": "dir", "c:\\users\\me\\ext-link": "link:E:\\", "c:\\users\\me\\notes.txt": "file" };
  const windows = {
    path: path.win32,
    stat: (file) => {
      const kind = paths[file.toLowerCase()];
      if (!kind || kind.startsWith("link:")) throw fault("ENOENT", file);
      return { isDirectory: () => kind === "dir" };
    },
    lstat: (file) => {
      const kind = paths[file.toLowerCase()];
      if (!kind) throw fault("ENOENT", file);
      return { isSymbolicLink: () => kind.startsWith("link:") };
    },
    readlink: (file) => paths[file.toLowerCase()].slice("link:".length),
    access: () => undefined
  };
  const spec = (source) => ["run", "--mount", `type=bind,source=${source},target=/workspace`, "img"];
  const blocked = (source, io = windows) => {
    const [gone] = missingBindSources(spec(source), io);
    assert.equal(gone?.source, source);
    return gone.unmakeable ?? null;
  };
  assert.deepEqual(blocked("E:\\Projects"), { at: "E:\\", why: "gone" });
  assert.deepEqual(blocked("E:\\Work\\Projects"), { at: "E:\\", why: "gone" }, "the root, not the first folder on the way that is not there");
  // By the path rules alone, a UNC path's root is its share: a stat faked to fail ENOENT there ends the walk at it. What
  // Windows gives for a share it does not reach is not measured here, and libuv's table gives no ENOENT for a network
  // path (ERROR_BAD_NETPATH, ERROR_BAD_NET_NAME: UNKNOWN; ERROR_NETWORK_UNREACHABLE: ENETUNREACH): a folder whose stat
  // fails so is not said to be missing at all.
  assert.deepEqual(blocked("\\\\nas\\share\\Projects"), { at: "\\\\nas\\share\\", why: "gone" });
  for (const code of ["UNKNOWN", "ENETUNREACH"]) {
    assert.deepEqual(missingBindSources(spec("\\\\nas\\share\\Projects"), { ...windows, stat: (file) => { throw fault(code, file); } }), [], code);
  }
  // What the walk said before, it says as before: a link to that drive, a file on the way, a folder install makes.
  assert.deepEqual(blocked("C:\\Users\\me\\Ext-link\\Projects"), { at: "C:\\Users\\me\\Ext-link", why: "link", leadsTo: "E:\\" });
  assert.deepEqual(blocked("C:\\Users\\me\\notes.txt\\Projects"), { at: "C:\\Users\\me\\notes.txt", why: "file" });
  assert.equal(blocked("C:\\Users\\me\\New\\Projects"), null);
  // A relative folder's way up ends at ".", which is no root: nothing is said of it there.
  assert.equal(blocked("rel\\Projects", { ...windows, stat: (file) => { throw fault("ENOENT", file); } }), null);
});

test("the --mount Docker's CLI refused is told by its own words, the value read back from Go's quotes", () => {
  // Docker 29.8.2's first line for each value it refused (`docker create --mount <value> …`, exit 125), as measured.
  const refused = [
    ["type=bind,source=/x,target=/y,readonly=TRUE", "invalid argument \"type=bind,source=/x,target=/y,readonly=TRUE\" for \"--mount\" flag: invalid value for 'readonly': invalid boolean value (\"TRUE\"): must be one of \"true\", \"1\", \"false\", or \"0\" (default \"true\")"],
    ["type=bind,source=/x\u00a0,target=/y", "invalid argument \"type=bind,source=/x\\u00a0,target=/y\" for \"--mount\" flag: invalid value for 'source' in 'source=/x\u00a0': value should not have whitespace"],
    ["\ufefftype=bind,source=/x,target=/y", "invalid argument \"\\ufefftype=bind,source=/x,target=/y\" for \"--mount\" flag: unknown option '\ufefftype' in '\ufefftype=bind'"],
    ["type=bind,source=/x\t,target=/y", "invalid argument \"type=bind,source=/x\\t,target=/y\" for \"--mount\" flag: invalid value for 'source' in 'source=/x\t': value should not have whitespace"],
    ["type=bind,source=C:\\Users\\me,target=/y,bogus=1", "invalid argument \"type=bind,source=C:\\\\Users\\\\me,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/\u041f\u0440\u043e\u0435\u043a\u0442\u044b \u{1F600},target=/y,bogus=1", "invalid argument \"type=bind,source=/\u041f\u0440\u043e\u0435\u043a\u0442\u044b \u{1F600},target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u200b,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u200b,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u0001\u0007\u000b,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\x01\\a\\v,target=/y,bogus=1\" for \"--mount\" flag: invalid value for 'source' in 'source=/x\u0001\u0007\u000b': value should not have whitespace"],
    ["type=bind,source=/x\u00ad,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u00ad,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u007f,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\x7f,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u2028,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u2028,target=/y,bogus=1\" for \"--mount\" flag: invalid value for 'source' in 'source=/x\u2028': value should not have whitespace"],
    ["type=bind,source=/x\u0085z,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u0085z,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\"q\",target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\\"q\\\",target=/y,bogus=1\" for \"--mount\" flag: parse error on line 1, column 20: bare \" in non-quoted-field"],
    ["type=bind,source=/x\u{1F600}\u{E0001}\u{10FFFF},target=/y,bogus=1", "invalid argument \"type=bind,source=/x\u{1F600}\\U000e0001\\U0010ffff,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u3000y,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u3000y,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u0300\u200d\u2060\u180e,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\u0300\\u200d\\u2060\\u180e,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"]
  ];
  const usage = "\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n";
  for (const [value, said] of refused) {
    assert.equal(refusedMount(["type=volume,source=v,target=/data,bogus=1", value], { code: 125, stderr: `${said}${usage}` }), value, said);
  }
  // CLI 27.5.1 in its own words, of a value it does not trim (Docker 29 does, and reads it): that value, not another.
  const cli27 = "invalid argument \" type=volume,source=r5c-lead27,target=/data\" for \"--mount\" flag: unexpected key ' type' in ' type=volume'\nSee 'docker run --help'.\n";
  assert.equal(refusedMount([" type=volume,source=r5c-lead27,target=/data"], { code: 125, stderr: cli27 }), " type=volume,source=r5c-lead27,target=/data");
  assert.equal(refusedMount(["type=bind,source=/m,target=/models,readonly=TRUE"], { code: 125, stderr: cli27 }), undefined, "a value Docker did not name");
  // A start that failed otherwise is no --mount's doing: another exit, the daemon's words, or none.
  const [[value, said]] = refused;
  assert.equal(refusedMount([value], { code: 1, stderr: said }), undefined);
  assert.equal(refusedMount([value], { code: null, stderr: said }), undefined);
  assert.equal(refusedMount([value], { code: 125, stderr: "docker: Error response from daemon: invalid mount config for type \"bind\": bind source path does not exist: /gone\n" }), undefined);
  assert.equal(refusedMount([value], { code: 125 }), undefined);
  assert.equal(refusedMount([], { code: 125, stderr: said }), undefined);
  // A value is told whole: one that ends another value Docker quoted is not it.
  assert.equal(refusedMount(["b"], { code: 125, stderr: "invalid argument \"x\\\"b\" for \"--mount\" flag: bare \" in non-quoted-field\n" }), undefined);
});

test("Docker's quotes are read back, not made again: a character Go 1.26 does not print as it is, each of Go's escapes, a lone surrogate given as U+FFFD", () => {
  // Docker 29.8.2's first line for each (`docker run --mount <value> …`, exit 125), as measured. Its Go is at Unicode
  // 15.0, Node 22 at 16.0: the characters of 15.1 and 16.0 Docker escapes, U+31EF … U+1FAE9.
  const refused = [
    ["type=bind,source=/x\u31ef,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u31ef,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u2ffc,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\u2ffc,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u{2EBF0},target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\U0002ebf0,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u{1CC00},target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\U0001cc00,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\u{10D4A},target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\U00010d4a,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/home/me/Models \u{1FAE9},target=/models,readonly=TRUE", "invalid argument \"type=bind,source=/home/me/Models \\U0001fae9,target=/models,readonly=TRUE\" for \"--mount\" flag: invalid value for 'readonly': invalid boolean value (\"TRUE\"): must be one of \"true\", \"1\", \"false\", or \"0\" (default \"true\")"],
    // Each escape Go writes, the ones the lines above do not have.
    ["type=bind,source=/x\u0007,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\a,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\b,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\b,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\fz,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\fz,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x,target=/y,bogus=1\nz", "invalid argument \"type=bind,source=/x,target=/y,bogus=1\\nz\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\r,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\r,target=/y,bogus=1\" for \"--mount\" flag: invalid value for 'source' in 'source=/x\r': value should not have whitespace"],
    ["type=bind,source=/x\u0001\u001f\u007f,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\\x01\\x1f\\x7f,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    // A lone surrogate reaches Docker as UTF-8, that is as U+FFFD, which Go prints as it is.
    ["type=bind,source=/x\ud800,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\ufffd,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"],
    ["type=bind,source=/x\udc00y,target=/y,bogus=1", "invalid argument \"type=bind,source=/x\ufffdy,target=/y,bogus=1\" for \"--mount\" flag: unknown option 'bogus' in 'bogus=1'"]
  ];
  const usage = "\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n";
  for (const [value, said] of refused) {
    assert.equal(refusedMount(["type=volume,source=v,target=/data,bogus=1", value], { code: 125, stderr: `${said}${usage}` }), value, said);
    assert.equal(refusedMount(["type=volume,source=v,target=/data,bogus=1"], { code: 125, stderr: `${said}${usage}` }), undefined, `${said}: not another value`);
  }
  // Escaped, a backslash and a quote are themselves, and \x, \u and \U take as many digits as they are written with.
  assert.equal(refusedMount(["a\\x41\"b"], { code: 125, stderr: "invalid argument \"a\\\\x41\\\"b\" for \"--mount\" flag: x\n" }), "a\\x41\"b");
  assert.equal(refusedMount(["AA1B"], { code: 125, stderr: "invalid argument \"\\x41\\u00411\\U00000042\" for \"--mount\" flag: x\n" }), "AA1B");
  // A number past Unicode is no character: nothing is named, and nothing thrown.
  assert.equal(refusedMount(["x"], { code: 125, stderr: "invalid argument \"\\U00110000\" for \"--mount\" flag: x\n" }), undefined);
});

test("Docker's refusal is found wherever it is in what Docker wrote: after the warning of a config file it could not read", () => {
  // Docker 29.8.2 with its config.json broken, and with a folder in its place, as measured (the home shortened): the
  // warning comes first, then the refusal.
  const value = "type=bind,source=/tmp,target=/models,readonly=TRUE";
  const refusal = "invalid argument \"type=bind,source=/tmp,target=/models,readonly=TRUE\" for \"--mount\" flag: invalid value for 'readonly': invalid boolean value (\"TRUE\"): must be one of \"true\", \"1\", \"false\", or \"0\" (default \"true\")\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n";
  for (const warning of [
    "WARNING: Error parsing config file (/home/me/.docker/config.json): invalid character 'b' looking for beginning of object key string\n",
    "WARNING: Error parsing config file (/home/me/.docker/config.json): read /home/me/.docker/config.json: is a directory\n"
  ]) {
    assert.equal(refusedMount(["type=volume,source=v,target=/data,bogus=1", value], { code: 125, stderr: `${warning}${refusal}` }), value, warning);
  }
  // CLI 27.5.1 with its config.json broken, as measured: its own warning, then its refusal.
  const bogus = "type=bind,source=/tmp,target=/models,bogus=1";
  const cli27 = "WARNING: Error loading config file: /home/me/.docker/config.json: : invalid character 'b' looking for beginning of object key string\ninvalid argument \"type=bind,source=/tmp,target=/models,bogus=1\" for \"--mount\" flag: unexpected key 'bogus' in 'bogus=1'\nSee 'docker run --help'.\n";
  assert.equal(refusedMount([value, bogus], { code: 125, stderr: cli27 }), bogus);
});

test("an entry's options are read back from what it runs, so writing it again keeps them", () => {
  const linux = dockerRunArgs({ image: "ai-dev-system:p14r2", volume: "other-data", projects: "/home/me/AI-Dev-Projects", state: "/home/me/.ai-dev/state", model: { source: "/home/me/models/bge-m3-onnx", target: CONTAINER_MODEL_DIR }, platform: "linux" });
  assert.deepEqual(dockerEntryOptions(linux), { image: "ai-dev-system:p14r2", volume: "other-data", projects: "/home/me/AI-Dev-Projects", state: "/home/me/.ai-dev/state", model: "/home/me/models", data: "" });
  const windows = dockerRunArgs({ image: "img", projects: "C:\\Users\\me\\AI-Dev-Projects", model: "C:\\models", platform: "win32" });
  assert.deepEqual(dockerEntryOptions(windows), { image: "img", volume: DEFAULT_DOCKER_VOLUME, projects: "C:\\Users\\me\\AI-Dev-Projects", state: "", model: "C:\\models", data: "" });
  assert.equal(dockerEntryOptions(["run", "--mount", "type=bind,source=C:\\m\\bge-m3-onnx,target=/models/bge-m3-onnx,readonly", "img"]).model, "C:\\m");
  assert.deepEqual(dockerEntryOptions(undefined), { image: "", volume: "", projects: "", state: "", model: "", data: "" });
});

test("the data volume of a --mount Docker 29 cannot read is read back all the same, so writing the entry again keeps it", () => {
  const options = (...mounts) => dockerEntryOptions(["run", "-i", ...mounts.flatMap((mount) => ["--mount", mount]), "img"]);
  // The review's entry, volume-nocopy=TRUE, which the CLIs before 29 read, and other spellings of the volume at /data.
  for (const value of ["type=volume,source=my-team-data,target=/data,volume-nocopy=TRUE", "source=my-team-data,target=/data,bogus=1",
    "type=volume, source=my-team-data ,dst=/data", "TYPE=Volume,SRC=my-team-data,Target=/data,volume-nocopy=TRUE",
    "type=volume,source=my-team-data,destination=/data,volume-opt=o=bind,bogus=1"]) {
    assert.deepEqual(unreadableMounts(["run", "--mount", value, "img"]), [value], value);
    assert.equal(options(value).volume, "my-team-data", value);
  }
  // No volume at /data: another target, a bind, no source, a value no CLI parses.
  for (const value of ["type=volume,source=other,target=/elsewhere,bogus=1", "type=bind,source=/srv/data,target=/data,bogus=1",
    "type=volume,target=/data,bogus=1", "type=volume,\"source=x,target=/data"]) {
    assert.equal(options(value).volume, "", value);
  }
  // Another --mount it cannot read beside it takes nothing from it; the ones it can read are read as before.
  assert.deepEqual(options("type=volume,source=mine,target=/data,volume-nocopy=TRUE", "type=bind,source=/m,target=/models,readonly=TRUE", "type=bind,source=/p,target=/p"),
    { image: "img", volume: "mine", projects: "/p", state: "", model: "", data: "" });
  // Docker cleans the path it mounts at: `dst=/data/` is the volume at /data, as the CLIs before 29 run it.
  assert.equal(options("type=volume,src=my-team-data,dst=/data/,volume-nocopy=TRUE").volume, "my-team-data");
  assert.equal(options("type=volume,source=my-team-data,target=//data/").volume, "my-team-data");
  assert.equal(options("type=bind,source=/s,target=/ai-dev-state/").state, "/s");
  // An image or a tmpfs at /data is neither a volume of the data's nor a folder bound in its place.
  for (const value of ["type=image,source=ai-dev-system:3,target=/data", "type=tmpfs,target=/data"]) {
    assert.deepEqual([options(value).volume, options(value).data], ["", ""], value);
  }
  // A folder bound at /data, read or not, is no projects folder: it is the data's, in place of the volume.
  assert.deepEqual(options("type=bind,source=/p,target=/workspace", "type=bind,source=/t,target=/data"),
    { image: "img", volume: "", projects: "/p", state: "", model: "", data: "/t" });
  assert.deepEqual(options("type=bind,source=/p,target=/workspace", "type=bind,source=/t,target=/data,bind-nonrecursive"),
    { image: "img", volume: "", projects: "/p", state: "", model: "", data: "/t" });
});

test("the image names the volume at its /data as Docker, rootless Docker and Podman mount it; a run that mounts none gets the default by its name, a mount with no name a placeholder", () => {
  const line = (root, target = "/data") => `173 155 254:0 ${root} ${target} rw,relatime master:1 - ext4 /dev/vda rw,discard`;
  const other = line("/var/lib/docker/volumes/models-x/_data", "/models");
  assert.equal(volumeAtData([other, line("/var/lib/docker/volumes/team-data/_data")].join("\n")), "team-data");
  // /var/lib/docker on a disk of its own, rootless Docker, Podman.
  assert.equal(volumeAtData(line("/volumes/r14f-data/_data")), "r14f-data");
  assert.equal(volumeAtData(line("/home/me/.local/share/docker/volumes/a.b_c-1/_data")), "a.b_c-1");
  assert.equal(volumeAtData(line("/home/me/.local/share/containers/storage/volumes/pod/_data")), "pod");
  // Of two mounts at /data the later is the one seen there; one under /data is another.
  assert.equal(volumeAtData([line("/var/lib/docker/volumes/first/_data"), line("/var/lib/docker/volumes/second/_data")].join("\n")), "second");
  assert.equal(volumeAtData([line("/var/lib/docker/volumes/outer/_data"), line("/var/lib/docker/volumes/inner/_data", "/data/inner")].join("\n")), "outer");
  // A run that mounts nothing at /data gets an anonymous volume, which --rm removes, or none at all: the default.
  for (const mountinfo of [line(`/var/lib/docker/volumes/${"e2".repeat(32)}/_data`), other, "", "garbage"]) {
    assert.equal(volumeAtData(mountinfo), DEFAULT_DOCKER_VOLUME, mountinfo);
  }
  // Only a name of 64 hex digits is taken for the anonymous one: these keep theirs, 64 with a letter past f or in capitals
  // too.
  for (const name of ["cafe", "2024", "e2".repeat(31) + "e", "e2".repeat(32) + "e", `x${"e2".repeat(32)}`, `${"e2".repeat(32)}x`, `${"e2".repeat(31)}eg`, "E2".repeat(32)]) {
    assert.equal(volumeAtData(line(`/var/lib/docker/volumes/${name}/_data`)), name, name);
  }
  // A mount with no name to give — a folder, a volume made with a driver's options, a volume's subfolder, a tmpfs, a
  // name no volume may have, a folder named like volumes — and the advice holds a placeholder for it.
  for (const root of ["/home/me/ai-dev-data", "/var/tmp/dev", "/var/lib/docker/volumes/x/_data/sub", "/", "/var/lib/docker/volumes/_x/_data", "/srv/myvolumes/x/_data"]) {
    assert.equal(volumeAtData(line(root)), null, root);
  }
  assert.equal(dataMount("team-data"), "type=volume,source=team-data,target=/data");
  assert.equal(dataMount(null), "<what your sessions mount at /data>");
  // This volume only of a name read at /data: the default, which the image cannot tell from none, by its name.
  assert.equal(dataPlace("team-data"), "in this volume");
  assert.equal(dataPlace(DEFAULT_DOCKER_VOLUME), "in the default volume, ai-dev-system-data");
  assert.equal(dataPlace(null), "where your sessions keep /data");
  // The image's advice only: AI_DEV_RUNTIME=docker, however written; anywhere else the default, whatever is at /data.
  const read = () => line("/var/lib/docker/volumes/team-data/_data");
  for (const runtime of [undefined, "", "local", "dockers"]) assert.equal(dataVolume({ env: { AI_DEV_RUNTIME: runtime }, read }), DEFAULT_DOCKER_VOLUME, runtime);
  for (const runtime of ["docker", " Docker "]) assert.equal(dataVolume({ env: { AI_DEV_RUNTIME: runtime }, read }), "team-data", runtime);
  // No /proc to read: the default.
  const refused = () => { throw Object.assign(new Error("EACCES: permission denied, open '/proc/self/mountinfo'"), { code: "EACCES" }); };
  assert.equal(dataVolume({ env: { AI_DEV_RUNTIME: "docker" }, read: refused }), DEFAULT_DOCKER_VOLUME);
});

test("a 3.0 entry is told from a 2.x launcher by what it runs", () => {
  assert.equal(isDirectDockerEntry({ command: "/usr/bin/docker", args: ["run", "-i"] }), true);
  assert.equal(isDirectDockerEntry({ command: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", args: ["run"] }), true);
  assert.equal(isDirectDockerEntry({ command: "/bin/sh", args: ["/repo/docker/run-mcp.sh"] }), false);
  assert.equal(isDirectDockerEntry({ command: "docker", args: ["exec", "-i", "c"] }), false);
  assert.equal(isDirectDockerEntry({}), false);
});

test("the state folder is shared only when the image's user, tried, writes it as the host user", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-share-probe-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 0;
  const calls = [];
  // A container that writes the file it is given, as this user: what Docker Desktop and a matching uid do.
  const writes = (command, args) => {
    calls.push([command, ...args]);
    const target = args.at(-1);
    assert.ok(target.startsWith(`${CONTAINER_STATE_ROOT}/.ai-dev-share-probe-`), target);
    fsSync.writeFileSync(path.join(state, path.basename(target)), "");
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(probeStateSharing({ docker: "/usr/bin/docker", image: "img:3", state, uid, run: writes }), { shared: true, tried: true, reason: "" });
  const [call] = calls;
  assert.deepEqual(call.slice(0, 9), ["/usr/bin/docker", "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "touch"], "the image is not pulled for a probe");
  assert.ok(call.includes(`type=bind,source=${state},target=${CONTAINER_STATE_ROOT}`) && call.includes("img:3"));
  assert.deepEqual(await fs.readdir(state), [], "the probe leaves nothing behind");

  // Rootless Docker, userns-remap, Podman: uid 1000 in the container is no one here, and the folder refuses it.
  const refused = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 1, stdout: "", stderr: "touch: cannot touch '/ai-dev-state/x': Permission denied\n" }) });
  assert.deepEqual([refused.shared, refused.tried], [false, true]);
  assert.match(refused.reason, /could not write your state folder \(touch: cannot touch .*Permission denied\)/);
  // Docker that did not run the image tried nothing: not a remapping host.
  const down = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 1, stdout: "", stderr: "failed to connect to the docker API at unix:///nowhere.sock\n" }) });
  assert.deepEqual([down.shared, down.tried], [false, false]);
  assert.match(down.reason, /Docker did not run img to try it \(failed to connect to the docker API/);
  const missing = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 125, stdout: "", stderr: "docker: Error response from daemon: No such image: img\nRun 'docker run --help' for more information\n" }) });
  assert.match(missing.reason, /\(docker: Error response from daemon: No such image: img\)/, "Docker's own line, not its help trailer");
  const unreachable = probeStateSharing({ image: "img", state, uid, run: () => ({ error: new Error("spawn docker ENOENT") }) });
  assert.deepEqual([unreachable.shared, unreachable.tried], [false, false]);
  assert.match(unreachable.reason, /spawn docker ENOENT/);
  const lost = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.deepEqual(lost, { shared: false, tried: true, reason: "what the image's user wrote into your state folder did not reach it" });
  // Written, but as another uid: the server's files would be someone else's here.
  const other = probeStateSharing({ image: "img", state, uid: uid + 4242, run: writes });
  assert.deepEqual([other.shared, other.tried], [false, true]);
  assert.match(other.reason, new RegExp(`is uid ${uid}'s, not yours \\(uid ${uid + 4242}\\)`));
  assert.deepEqual(await fs.readdir(state), []);
});
