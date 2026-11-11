import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { openUrl, proxyFetch as serverFetch, proxyFor as serverProxyFor } from "./http-download.mjs";
import { fetchPackageMetadata } from "./security-fix-registry.mjs";
import { proxyFetch as hookFetch, proxyFor as hookProxyFor } from "../../hooks/http-proxy.mjs";
import { checkSupplyChain } from "../../hooks/supply-chain.mjs";
import { TEST_HOST, TEST_PROXY_TLS, TEST_TLS, startModelHost, startProxy } from "../../test/fixtures/model-host.mjs";

// The supply-chain hook and the fix registry used `fetch`, which reads no
// proxy variable: behind a proxy nothing was checked.
// The hook carries its own copy of the server's proxy client (AGENTS.md,
// rule 3), and the two must choose the same way.

const NOW = Date.parse("2026-10-11T12:00:00Z");

/** A registry, its advisory endpoint and OSV, on one plain-HTTP port. */
async function startRegistry() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, host: request.headers.host, path: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url.endsWith("/-/npm/v1/security/advisories/bulk")) return response.end("{}");
      if (request.url.endsWith("/v1/querybatch")) return response.end(JSON.stringify({ results: [{}] }));
      return response.end(JSON.stringify({
        name: "left-pad",
        "dist-tags": { latest: "1.3.0" },
        time: { "1.2.0": "2017-01-01T00:00:00Z", "1.3.0": "2018-01-01T00:00:00Z" },
        versions: { "1.2.0": {}, "1.3.0": {} }
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the hook's copy of the proxy choice answers as the server's does", () => {
  const cases = [
    ["https://registry.npmjs.org/x", {}],
    ["https://registry.npmjs.org/x", { HTTPS_PROXY: "http://proxy.corp:3128" }],
    ["https://registry.npmjs.org/x", { https_proxy: "proxy.corp:3128", HTTPS_PROXY: "http://other:1" }],
    ["http://registry.internal/x", { HTTPS_PROXY: "http://p:1" }],
    ["http://registry.internal/x", { HTTP_PROXY: "http://user:pa%40ss@p:1" }],
    ["https://api.osv.dev/v1", { HTTPS_PROXY: "http://p:1", NO_PROXY: ".osv.dev" }],
    ["https://api.osv.dev/v1", { HTTPS_PROXY: "http://p:1", NO_PROXY: "*.osv.dev:8443" }],
    ["https://10.1.2.3/x", { HTTPS_PROXY: "http://p:1", NO_PROXY: "10.0.0.0/8" }],
    ["https://11.1.2.3/x", { HTTPS_PROXY: "http://p:1", NO_PROXY: "10.0.0.0/8" }],
    ["http://127.0.0.1:9/x", { HTTP_PROXY: "http://p:1" }],
    ["http://localhost/x", { HTTP_PROXY: "http://p:1" }],
    ["https://x.example/", { HTTPS_PROXY: "http://p:1", no_proxy: "*" }]
  ];
  for (const [url, env] of cases) {
    assert.equal(hookProxyFor(url, env)?.href ?? null, serverProxyFor(url, env)?.href ?? null, `${url} ${JSON.stringify(env)}`);
  }
  for (const env of [{ HTTPS_PROXY: "socks5://p:1080" }, { HTTPS_PROXY: "http://u:secret@[bad" }]) {
    const message = (pick) => {
      try {
        pick("https://x.example/", env);
        return "";
      } catch (error) {
        return error.message;
      }
    };
    assert.equal(message(hookProxyFor), message(serverProxyFor));
    assert.ok(message(hookProxyFor) && !message(hookProxyFor).includes("secret"));
  }
});

test("the supply-chain hook and the fix registry go through HTTP_PROXY: registry, advisories and OSV", async (t) => {
  const registry = await startRegistry();
  t.after(() => registry.close());
  const proxy = await startProxy({ hosts: { "registry.example.test": registry.port, "osv.example.test": registry.port } });
  t.after(() => proxy.close());
  const env = { HTTP_PROXY: proxy.url, npm_config_registry: "http://registry.example.test", AI_DEV_OSV_API: "http://osv.example.test" };

  const verdict = await checkSupplyChain([["npm", "i", "left-pad"]], { env, now: NOW });
  assert.deepEqual(verdict, { blocks: [], warns: [] }, "fully checked, nothing to say");
  assert.deepEqual(proxy.seen, [
    "GET http://registry.example.test/left-pad",
    "POST http://registry.example.test/-/npm/v1/security/advisories/bulk",
    "POST http://osv.example.test/v1/querybatch"
  ]);
  assert.deepEqual(JSON.parse(registry.requests[1].body), { "left-pad": ["1.3.0"] }, "the POST body arrives whole");

  const before = proxy.seen.length;
  const metadata = await serverFetch("http://registry.example.test/left-pad", { env }).then((response) => response.json());
  assert.equal(metadata.name, "left-pad");
  const previous = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = proxy.url;
  t.after(() => {
    if (previous === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previous;
  });
  const fixes = await fetchPackageMetadata("left-pad", { registry: "http://registry.example.test" });
  assert.deepEqual(fixes.versions, ["1.2.0", "1.3.0"]);
  assert.equal(proxy.seen.length, before + 2, "the fix registry asked through the proxy too");
});

test("HTTPS goes through a CONNECT tunnel to the host's own certificate, POST bodies included, in both copies", async (t) => {
  const seen = [];
  const server = https.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push(`${request.method} ${request.url} ${body}`);
      response.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
      response.end(JSON.stringify({ echoed: body }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const proxy = await startProxy({ hosts: { [TEST_HOST]: server.address().port } });
  t.after(() => proxy.close());
  const env = { HTTPS_PROXY: proxy.url };
  for (const fetchVia of [hookFetch, serverFetch]) {
    const response = await fetchVia(`https://${TEST_HOST}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"q\":1}",
      env,
      ...(fetchVia === hookFetch ? { ca: TEST_TLS.cert } : {})
    }).catch((error) => error);
    if (fetchVia === serverFetch) {
      // The server's copy trusts the system store only, as a user's machine does.
      assert.match(String(response?.message), /certificate|self.signed|issuer/i);
      continue;
    }
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("X-Test"), "yes");
    assert.deepEqual(await response.json(), { echoed: "{\"q\":1}" });
  }
  assert.deepEqual(proxy.seen.slice(0, 1), [`CONNECT ${TEST_HOST}:443`]);
  assert.deepEqual(seen, ["POST /v1/querybatch {\"q\":1}"]);
});

test("an https:// proxy is checked by its own name in the hooks' copy too, for a tunnel and for plain HTTP", async (t) => {
  const files = { "config.json": "{\"ok\":true}" };
  const host = await startModelHost({ files, tls: true });
  const plain = await startModelHost({ files });
  const plainHost = "plain.example.test";
  // The proxy's certificate names localhost alone, the host's its own name.
  const proxy = await startProxy({ hosts: { [TEST_HOST]: host.port, [plainHost]: plain.port }, tls: true });
  t.after(() => Promise.all([host.close(), plain.close(), proxy.close()]));
  const both = [TEST_TLS.cert, TEST_PROXY_TLS.cert];
  const tunnelled = await hookFetch(`https://${TEST_HOST}:${host.port}/m/config.json`, { env: { HTTPS_PROXY: proxy.url }, ca: both });
  assert.deepEqual([tunnelled.status, await tunnelled.text()], [200, files["config.json"]]);
  const plainUrl = `http://${plainHost}:${plain.port}/m/config.json`;
  const forwarded = await hookFetch(plainUrl, { env: { HTTP_PROXY: proxy.url }, ca: both });
  assert.deepEqual([forwarded.status, await forwarded.text()], [200, files["config.json"]]);
  assert.deepEqual(proxy.seen, [`CONNECT ${TEST_HOST}:${host.port}`, `GET ${plainUrl}`]);
  // A proxy whose certificate is not trusted is still refused.
  await assert.rejects(
    hookFetch(plainUrl, { env: { HTTP_PROXY: proxy.url }, ca: TEST_TLS.cert }),
    /could not be reached through the proxy https:\/\/localhost:\d+: (?!ERR_TLS_CERT_ALTNAME_INVALID)/
  );
});

test("through a tunnel the Host header names the port only when the address does, in both copies", async (t) => {
  const hosts = [];
  const server = https.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (request, response) => {
    hosts.push(request.headers.host);
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const proxy = await startProxy({ hosts: { [TEST_HOST]: server.address().port } });
  t.after(() => proxy.close());
  // The server's copy trusts what the session's NODE_EXTRA_CA_CERTS names; the hooks' takes `ca`.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-host-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authority = path.join(directory, "ca.pem");
  await fs.writeFile(authority, TEST_TLS.cert);
  for (const fetchVia of [hookFetch, serverFetch]) {
    for (const url of [`https://${TEST_HOST}/x`, `https://${TEST_HOST}:443/x`, `https://${TEST_HOST}:8443/x`]) {
      const response = await fetchVia(url, { env: { HTTPS_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: authority }, ...(fetchVia === hookFetch ? { ca: TEST_TLS.cert } : {}) });
      assert.equal(response.status, 200);
    }
  }
  const expected = [TEST_HOST, TEST_HOST, `${TEST_HOST}:8443`];
  assert.deepEqual(hosts, [...expected, ...expected]);
});

test("a proxy that wants credentials is told apart from one that refused them, in both copies", async (t) => {
  const proxy = await startProxy({ hosts: { [TEST_HOST]: 9 }, credentials: "alice:secret" });
  t.after(() => proxy.close());
  const port = new URL(proxy.url).port;
  for (const fetchVia of [hookFetch, serverFetch]) {
    await assert.rejects(fetchVia(`https://${TEST_HOST}/x`, { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }), /\(HTTP 407\)\. The proxy wants credentials: put them in the proxy URL/);
    await assert.rejects(fetchVia(`https://${TEST_HOST}/x`, { env: { HTTPS_PROXY: `http://alice:wrong@127.0.0.1:${port}` } }), /\(HTTP 407\)\. The proxy did not accept the user name and password in the proxy URL\./);
  }
});

test("a lookup that hangs is named a timeout, through the proxy as without it", async (t) => {
  const silent = http.createServer(() => undefined);
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    silent.closeAllConnections();
    return new Promise((resolve) => silent.close(resolve));
  });
  const proxy = await startProxy({ hosts: { "registry.example.test": silent.address().port } });
  t.after(() => proxy.close());
  const verdict = await checkSupplyChain([["npm", "i", "left-pad"]], {
    env: { HTTP_PROXY: proxy.url, npm_config_registry: "http://registry.example.test" },
    policy: { supply_chain: { timeout_ms: 200 } },
    now: NOW
  });
  assert.deepEqual(verdict.blocks, []);
  assert.deepEqual(verdict.warns, ["[supply-chain] left-pad@latest was not fully checked: the registry could not be read: no answer in 0.2s."]);
  await assert.rejects(hookFetch("http://registry.example.test/x", { env: { HTTP_PROXY: proxy.url }, signal: AbortSignal.timeout(100) }), { name: "TimeoutError" });
  await assert.rejects(serverFetch("http://registry.example.test/x", { env: { HTTP_PROXY: proxy.url }, signal: AbortSignal.timeout(100) }), { name: "TimeoutError" });
});

test("a 301 after a POST is followed with a GET and no body; a 307 sends the body again", async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push(`${request.method} ${request.url} ${body}`);
      if (request.url === "/moved") {
        response.writeHead(301, { location: "/here" });
        return response.end();
      }
      if (request.url === "/temporary") {
        response.writeHead(307, { location: "/here" });
        return response.end();
      }
      response.writeHead(200);
      return response.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const fetchVia of [hookFetch, serverFetch]) {
    seen.length = 0;
    assert.equal(await (await fetchVia(`${base}/moved`, { method: "POST", body: "x", env: {} })).text(), "ok");
    assert.equal(await (await fetchVia(`${base}/temporary`, { method: "POST", body: "y", env: {} })).text(), "ok");
    assert.deepEqual(seen, ["POST /moved x", "GET /here ", "POST /temporary y", "POST /here y"]);
  }
});

test("answers come compressed and are decoded in both copies; the model download still asks for none", async (t) => {
  const document = JSON.stringify({ name: "typescript", readme: "a long readme ".repeat(5000) });
  const encoders = {
    gzip: zlib.gzipSync,
    deflate: zlib.deflateSync,
    "raw-deflate": zlib.deflateRawSync,
    br: zlib.brotliCompressSync,
    identity: (bytes) => bytes
  };
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.url} ${request.headers["accept-encoding"]}`);
    const coding = request.url.slice(1);
    if (coding === "zstd") {
      response.writeHead(200, { "content-encoding": "zstd" });
      return response.end("not zstd at all");
    }
    if (coding === "no-content") {
      response.writeHead(204, { "content-encoding": "gzip" });
      return response.end();
    }
    if (coding === "no-trailer") {
      const whole = zlib.gzipSync(document);
      response.writeHead(200, { "content-encoding": "gzip" });
      return response.end(whole.subarray(0, whole.length - 8));
    }
    response.writeHead(200, { "content-type": "application/json", "content-encoding": coding === "raw-deflate" ? "deflate" : coding });
    return response.end(encoders[coding](Buffer.from(document)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const fetchVia of [hookFetch, serverFetch]) {
    seen.length = 0;
    for (const coding of Object.keys(encoders)) {
      const response = await fetchVia(`${base}/${coding}`, { env: {} });
      assert.deepEqual(await response.json(), JSON.parse(document), coding);
    }
    assert.equal(await (await fetchVia(`${base}/no-trailer`, { env: {} })).text(), document, "a gzip stream cut before its trailer");
    assert.equal(await (await fetchVia(`${base}/no-content`, { env: {} })).text(), "", "a 204 has nothing to decode");
    await assert.rejects((await fetchVia(`${base}/zstd`, { env: {} })).text(), /the answer came zstd-encoded, which was not asked for/);
    assert.ok(seen.every((line) => line.endsWith(" gzip, deflate, br")), seen.join("\n"));
  }
  const download = await openUrl(`${base}/identity`, { env: {} });
  download.body.resume();
  assert.equal(seen.at(-1), "/identity identity", "a download resumes bytes of the file itself");
});
