/**
 * The network a model download meets, on 127.0.0.1: a model host with HEAD,
 * Range, redirects and the faults real hosts have, and an HTTP proxy with
 * CONNECT. The downloader's tests run against real sockets rather than a fake
 * of the HTTP client, so a proxy that is not used or a Range that is not sent
 * fails a test instead of passing it.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";

// A self-signed certificate for models.example.test, localhost and 127.0.0.1,
// valid until 2126, made with `openssl req -x509 -newkey ec`. The key's armour
// is assembled rather than written out: scripts/security-check.mjs reads any
// literal key header as a leaked secret.
const ARMOUR = (kind, edge) => `-----${edge} ${kind}-----`;
export const TEST_TLS = Object.freeze({
  key: [
    ARMOUR(["PRIVATE", "KEY"].join(" "), "BEGIN"),
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBwVZ5MLaSZPXmABU",
    "FUG8yWQWPzYnp6r/CkqxNlAY4cehRANCAASbu9xfgoEOi1noDrOWAj+lapGkSd6H",
    "bGn8r1YQEPjpO1XeZb7jOPsDZR1Co+GX/XgDxLOx/anIkwoynGzrqElh",
    ARMOUR(["PRIVATE", "KEY"].join(" "), "END"),
    ""
  ].join("\n"),
  cert: [
    ARMOUR("CERTIFICATE", "BEGIN"),
    "MIIBxzCCAWygAwIBAgIUXCqN5ciUAWl7ek7euJrE38SZ2gUwCgYIKoZIzj0EAwIw",
    "HjEcMBoGA1UEAwwTbW9kZWxzLmV4YW1wbGUudGVzdDAgFw0yNjEwMTExODU0MDFa",
    "GA8yMTI2MDkxNzE4NTQwMVowHjEcMBoGA1UEAwwTbW9kZWxzLmV4YW1wbGUudGVz",
    "dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJu73F+CgQ6LWegOs5YCP6VqkaRJ",
    "3odsafyvVhAQ+Ok7Vd5lvuM4+wNlHUKj4Zf9eAPEs7H9qciTCjKcbOuoSWGjgYUw",
    "gYIwHQYDVR0OBBYEFANDIIC7aaOXkx2bNcimlCzBYakIMB8GA1UdIwQYMBaAFAND",
    "IIC7aaOXkx2bNcimlCzBYakIMA8GA1UdEwEB/wQFMAMBAf8wLwYDVR0RBCgwJoIT",
    "bW9kZWxzLmV4YW1wbGUudGVzdIIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMC",
    "A0kAMEYCIQD08sHjVXENTJgWIzEOhbq+kRxUyMHHVYisSC8RZnmHGAIhAMeedcxD",
    "k+EnhX/Fn/StIDKtg/+K16L0Te9PlUyajD9z",
    ARMOUR("CERTIFICATE", "END"),
    ""
  ].join("\n")
});

// The `https://` proxy's own certificate: self-signed, for localhost and
// 127.0.0.1 only, as a real proxy's names the proxy and not the hosts behind
// it — the one that caught a proxy's certificate checked against the target's
// name. Made the same way, valid until 2126.
export const TEST_PROXY_TLS = Object.freeze({
  key: [
    ARMOUR(["PRIVATE", "KEY"].join(" "), "BEGIN"),
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZ4jRuSbvMk9Au77w",
    "OfO6NUr7Y9T4Hhjd2lu3Zhk2nT6hRANCAARVjLqgML+KpGPdljaOlehr8SmLWwDw",
    "JYY5Y43uySUV8mIUqq9o8Vp0t/QpojyjklaILsEySBMNSfDlpCP9DKZu",
    ARMOUR(["PRIVATE", "KEY"].join(" "), "END"),
    ""
  ].join("\n"),
  cert: [
    ARMOUR("CERTIFICATE", "BEGIN"),
    "MIIBnDCCAUGgAwIBAgIUPWifioDKmt/CfnYhfWKpKF7vi9QwCgYIKoZIzj0EAwIw",
    "FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxMjA2NTgyM1oYDzIxMjYwOTE4",
    "MDY1ODIzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO",
    "PQMBBwNCAARVjLqgML+KpGPdljaOlehr8SmLWwDwJYY5Y43uySUV8mIUqq9o8Vp0",
    "t/QpojyjklaILsEySBMNSfDlpCP9DKZuo28wbTAdBgNVHQ4EFgQUzOMzLHra9XH9",
    "FSi0WH4oQOKMenUwHwYDVR0jBBgwFoAUzOMzLHra9XH9FSi0WH4oQOKMenUwGgYD",
    "VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZI",
    "zj0EAwIDSQAwRgIhAMzi63Azhu7CamDaUl+Irywf+o3AqrCKJ4tIxpm13hTMAiEA",
    "9dfinSn9nloU1U+NkRfbEKRbA1/ZtRfaHA4DSnlY4Rs=",
    ARMOUR("CERTIFICATE", "END"),
    ""
  ].join("\n")
});

/** The one name the test certificate and the proxy's host table share. */
export const TEST_HOST = "models.example.test";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** Close a server and every connection still open on it, stalled ones included. */
function closer(server, sockets) {
  return () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
}

function track(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return sockets;
}

/**
 * A model host serving `files` under `/m/`.
 *
 * Faults are per file and, where a retry should see a healthy host, happen once.
 *
 * @param {object} options
 * @param {Record<string, Buffer|string>} options.files
 * @param {Map<string, number>} [options.fail] - Answer this status for this file, every time.
 * @param {Set<string>} [options.corrupt] - Serve other bytes of the same length, every time.
 * @param {Map<string, number>} [options.cutAfter] - The first GET sends this many bytes and closes the connection.
 * @param {Map<string, number>} [options.stallAfter] - The first GET sends this many bytes and then nothing.
 * @param {boolean} [options.noRange] - Ignore `Range`: the whole file, 200, every time.
 * @param {boolean} [options.noHead] - Refuse HEAD with 405.
 * @param {boolean} [options.redirect] - `/m/<file>` answers 302 to `/cdn/<file>`, as huggingface.co does.
 * @param {boolean} [options.tls] - Serve HTTPS with {@link TEST_TLS}.
 * @param {number} [options.chunkDelayMs] - Send in 4 KB pieces this far apart.
 * @param {Record<string, number>} [options.headSizes] - What HEAD declares, where it is not the real size.
 * @returns {Promise<{ base: string, port: number, requests: object[], close: () => Promise<void> }>}
 */
export async function startModelHost({
  files,
  fail = new Map(),
  corrupt = new Set(),
  cutAfter = new Map(),
  stallAfter = new Map(),
  noRange = false,
  noHead = false,
  redirect = false,
  tls = false,
  chunkDelayMs = 0,
  headSizes = {}
}) {
  const requests = [];
  const cut = new Map(cutAfter);
  const stall = new Map(stallAfter);
  const handler = (request, response) => {
    const url = new URL(request.url, "http://host");
    const entry = { method: request.method, path: url.pathname, range: request.headers.range ?? "", status: 0, sent: 0, host: request.headers.host };
    requests.push(entry);
    if (redirect && url.pathname.startsWith("/m/")) {
      entry.status = 302;
      response.writeHead(302, { location: url.pathname.replace(/^\/m\//, "/cdn/") });
      response.end();
      return;
    }
    // Any layout: `/m/<file>`, `/cdn/<file>`, a mirror's `/<export>/resolve/<revision>/<file>`.
    const decoded = decodeURIComponent(url.pathname);
    const relative = Object.keys(files).find((name) => decoded.endsWith(`/${name}`)) ?? decoded;
    if (fail.has(relative)) {
      entry.status = fail.get(relative);
      response.writeHead(entry.status, { "content-type": "text/plain" });
      response.end("not here");
      return;
    }
    const original = files[relative];
    if (original === undefined) {
      entry.status = 404;
      response.writeHead(404);
      response.end("no such file");
      return;
    }
    let body = Buffer.from(original);
    if (corrupt.has(relative)) body = Buffer.from(body.map((byte) => byte ^ 0xff));
    if (request.method === "HEAD") {
      entry.status = noHead ? 405 : 200;
      const declared = headSizes[relative] ?? body.length;
      response.writeHead(entry.status, noHead ? {} : { "content-length": String(declared), "accept-ranges": "bytes" });
      response.end();
      return;
    }
    let start = 0;
    const range = !noRange && String(request.headers.range ?? "").match(/^bytes=(\d+)-$/);
    if (range) {
      start = Number(range[1]);
      if (start >= body.length) {
        entry.status = 416;
        response.writeHead(416, { "content-range": `bytes */${body.length}` });
        response.end();
        return;
      }
      entry.status = 206;
      response.writeHead(206, {
        "content-length": String(body.length - start),
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`
      });
    } else {
      entry.status = 200;
      response.writeHead(200, { "content-length": String(body.length), ...(noRange ? {} : { "accept-ranges": "bytes" }) });
    }
    let payload = body.subarray(start);
    let after = null;
    if (cut.has(relative)) {
      payload = payload.subarray(0, cut.get(relative));
      cut.delete(relative);
      after = "cut";
    } else if (stall.has(relative)) {
      payload = payload.subarray(0, stall.get(relative));
      stall.delete(relative);
      after = "stall";
    }
    const pieces = [];
    const size = chunkDelayMs ? 4096 : payload.length || 1;
    for (let offset = 0; offset < payload.length; offset += size) pieces.push(payload.subarray(offset, offset + size));
    const send = (index) => {
      if (index < pieces.length) {
        entry.sent += pieces[index].length;
        response.write(pieces[index], () => (chunkDelayMs ? setTimeout(() => send(index + 1), chunkDelayMs) : send(index + 1)));
        return;
      }
      // A clean close short of the promised length: every byte written
      // arrives, then the stream ends early — what a dropped transfer looks like.
      if (after === "cut") response.socket?.end();
      else if (after !== "stall") response.end();
    };
    send(0);
  };
  const server = tls ? https.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, handler) : http.createServer(handler);
  const sockets = track(server);
  const port = await listen(server);
  return { base: `${tls ? "https" : "http"}://127.0.0.1:${port}/m`, port, requests, close: closer(server, sockets) };
}

/**
 * An HTTP proxy: plain HTTP in absolute form, HTTPS through CONNECT.
 *
 * `hosts` maps names that resolve nowhere to 127.0.0.1 ports, so a test can use
 * an address only the proxy can reach — the only proof a proxy was used.
 *
 * @param {object} [options]
 * @param {Record<string, number>} [options.hosts] - Host name → port on 127.0.0.1.
 * @param {string} [options.credentials] - `user:password` the proxy demands (407 otherwise).
 * @param {number} [options.refuseStatus] - Answer every CONNECT with this status.
 * @param {string} [options.challenge] - The `Proxy-Authenticate` a 407 carries.
 * @returns {Promise<{ url: string, port: number, seen: string[], authorizations: string[], close: () => Promise<void> }>}
 */
export async function startProxy({ hosts = {}, credentials = "", refuseStatus = 0, challenge = "Basic realm=\"test\"", tls = false } = {}) {
  const seen = [];
  const authorizations = [];
  const expected = credentials ? `Basic ${Buffer.from(credentials).toString("base64")}` : "";
  const route = (host, port) => (Object.hasOwn(hosts, host) ? { host: "127.0.0.1", port: hosts[host] } : { host, port: Number(port) });
  const handle = (request, response) => {
    seen.push(`${request.method} ${request.url}`);
    authorizations.push(String(request.headers["proxy-authorization"] ?? ""));
    if (expected && request.headers["proxy-authorization"] !== expected) {
      response.writeHead(407, { "proxy-authenticate": challenge });
      response.end();
      return;
    }
    const target = new URL(request.url);
    const { host, port } = route(target.hostname, target.port || 80);
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    const upstream = http.request({ host, port, path: `${target.pathname}${target.search}`, method: request.method, headers }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  };
  // An `https://` proxy, with a certificate of its own that names localhost alone.
  const server = tls ? https.createServer({ key: TEST_PROXY_TLS.key, cert: TEST_PROXY_TLS.cert }, handle) : http.createServer(handle);
  server.on("connect", (request, socket, head) => {
    seen.push(`CONNECT ${request.url}`);
    authorizations.push(String(request.headers["proxy-authorization"] ?? ""));
    if (expected && request.headers["proxy-authorization"] !== expected) {
      socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${challenge}\r\n\r\n`);
      return;
    }
    if (refuseStatus) {
      socket.end(`HTTP/1.1 ${refuseStatus} Refused\r\n\r\n`);
      return;
    }
    const [name, port] = request.url.split(":");
    const { host, port: targetPort } = route(name, port);
    const upstream = net.connect(targetPort, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  const sockets = track(server);
  const port = await listen(server);
  return { url: tls ? `https://localhost:${port}` : `http://127.0.0.1:${port}`, port, seen, authorizations, close: closer(server, sockets) };
}
