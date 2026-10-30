// HTTP(S) requests through the proxy the environment names, for the hooks.
//
// The supply-chain check asks the npm registry, its advisory endpoint and OSV
// with `fetch`, and Node's `fetch` reads no proxy variable unless the process
// was started with NODE_USE_ENV_PROXY=1. Behind a corporate proxy every lookup
// failed with "fetch failed" and the guard warned "not fully checked" on every
// install.
//
// This is the server's client (src/core/http-download.mjs) copied, not
// imported: the hooks run inside other people's repositories without the
// server's package. The proxy choice — HTTPS_PROXY,
// HTTP_PROXY, NO_PROXY with suffixes, ports, CIDR blocks and `*`, loopback
// always direct — is the same code, and a test holds the two copies to the
// same answers. Zero dependencies, like every hook.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { promisify } from "node:util";
import zlib from "node:zlib";

const MAX_REDIRECTS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "ai-dev-system-hook";

/** A URL, or a setting meant to be one, with its credentials replaced by `***`. */
function redactCredentials(text) {
  return String(text ?? "")
    .replace(/(\/\/)[^/@\s]+@/g, "$1***@")
    .replace(/^[^/:@\s]+:[^/@\s]*@/, "***@");
}

/** A proxy variable as npm and undici read it: the lower-case spelling first. */
function envValue(env, name) {
  for (const key of [name.toLowerCase(), name]) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

/** IPv4 dotted quad → 32-bit number, or null. */
function ipv4Number(host) {
  if (net.isIPv4(host) === false) return null;
  return host.split(".").reduce((total, part) => (total * 256) + Number(part), 0);
}

/** The bare host: no brackets around an IPv6 literal, lower case, no trailing dot. */
function bareHost(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** The port a URL names or implies. */
function urlPort(url) {
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

/**
 * Whether this host goes to the network directly rather than through a proxy.
 * Same rules as the server's `bypassesProxy`.
 *
 * @param {URL} url
 * @param {string} noProxy
 * @returns {boolean}
 */
export function bypassesProxy(url, noProxy) {
  const host = bareHost(url.hostname);
  const port = urlPort(url);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const address = ipv4Number(host);
  if (address !== null && address >>> 24 === 127) return true;
  for (const raw of String(noProxy ?? "").split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort = 0;
    const portMatch = entry.match(/^(.*[^:\]]|\[[^\]]+\]):(\d+)$/);
    if (portMatch && !net.isIPv6(entry)) {
      entry = portMatch[1];
      entryPort = Number(portMatch[2]);
    }
    if (entryPort && entryPort !== port) continue;
    entry = bareHost(entry.replace(/^\*?\./, ""));
    const cidr = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
    if (cidr) {
      const base = ipv4Number(cidr[1]);
      const bits = Number(cidr[2]);
      if (address === null || base === null || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((address & mask) >>> 0) === ((base & mask) >>> 0)) return true;
      continue;
    }
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * The proxy a request to `url` goes through, or null for a direct connection.
 * Same rules as the server's `proxyFor`.
 *
 * @param {URL|string} target
 * @param {Record<string, string|undefined>} [env]
 * @returns {URL|null}
 */
export function proxyFor(target, env = process.env) {
  const url = target instanceof URL ? target : new URL(String(target));
  const value = url.protocol === "https:"
    ? envValue(env, "HTTPS_PROXY") || envValue(env, "HTTP_PROXY")
    : envValue(env, "HTTP_PROXY");
  if (!value || bypassesProxy(url, envValue(env, "NO_PROXY"))) return null;
  let proxy;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new Error(`The proxy setting "${redactCredentials(value)}" is not a URL. Write it as http://host:port.`);
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`The proxy ${proxy.protocol}//${proxy.host} is not an HTTP proxy, and only HTTP proxies are supported. `
      + "Point HTTPS_PROXY at an http:// or https:// proxy.");
  }
  return proxy;
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

/**
 * What a 407 means, as the server's copy says it: a scheme the hook does not
 * speak, credentials the proxy refused, or none given.
 */
function signInHint(proxy, challenge) {
  const schemes = [challenge ?? []].flat().join(",").toLowerCase();
  if (schemes && !/\bbasic\b/.test(schemes)) {
    const named = /negotiate|kerberos/.test(schemes) ? "Negotiate (Kerberos)" : /ntlm/.test(schemes) ? "NTLM" : "a sign-in";
    return ` The proxy asks for ${named}, which this check does not speak: point HTTPS_PROXY at a local proxy that signs in for it (cntlm, px).`;
  }
  if (proxy.username || proxy.password) return " The proxy did not accept the user name and password in the proxy URL.";
  return " The proxy wants credentials: put them in the proxy URL, as http://user:password@host:port.";
}

function authority(host, port) {
  return `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/**
 * The connection to an `https://` proxy, its certificate checked against the
 * proxy's own name — or its address, for a proxy named by one. Node's HTTPS
 * client takes the name to check from the Host header, and through a proxy
 * that header names the target. Same as the server's `overProxyTls`
 * (this copy kept the defect).
 */
function overProxyTls(proxy, ca) {
  const host = bareHost(proxy.hostname);
  return {
    createConnection: () => tls.connect({ host, port: urlPort(proxy), ...(net.isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}) })
  };
}

/** A socket to `host:port` through the proxy, opened with CONNECT. */
function tunnel(proxy, host, port, signal, ca) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: bareHost(proxy.hostname),
      port: urlPort(proxy),
      method: "CONNECT",
      path: authority(host, port),
      headers: { host: authority(host, port), "user-agent": USER_AGENT, ...proxyAuthorization(proxy) },
      signal,
      ...(proxy.protocol === "https:" ? overProxyTls(proxy, ca) : { agent: false })
    });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const credentials = response.statusCode === 407 ? signInHint(proxy, response.headers["proxy-authenticate"]) : "";
        reject(new Error(`the proxy ${proxy.protocol}//${proxy.host} refused to connect to ${authority(host, port)} (HTTP ${response.statusCode}).${credentials}`));
        return;
      }
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    request.once("error", reject);
    request.end();
  });
}

function requestOnce(url, { method, headers, env, signal, ca, body }) {
  const proxy = proxyFor(url, env);
  const host = bareHost(url.hostname);
  const port = urlPort(url);
  const sent = {
    "user-agent": USER_AGENT,
    accept: "*/*",
    "accept-encoding": "identity",
    ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
    ...headers
  };
  return new Promise((resolve, reject) => {
    let request;
    if (!proxy) {
      request = (url.protocol === "https:" ? https : http).request(url, { method, headers: sent, agent: false, signal, ...(ca ? { ca } : {}) });
    } else if (url.protocol === "http:") {
      request = http.request({
        host: bareHost(proxy.hostname),
        port: urlPort(proxy),
        method,
        path: url.href,
        headers: { ...sent, host: url.host, ...proxyAuthorization(proxy) },
        signal,
        ...(proxy.protocol === "https:" ? overProxyTls(proxy, ca) : { agent: false })
      });
    } else {
      request = https.request(url, {
        method,
        headers: sent,
        signal,
        // As the server's copy: without it `Host` named port 80.
        defaultPort: 443,
        createConnection: (_options, done) => {
          tunnel(proxy, host, port, signal, ca).then((socket) => {
            done(null, tls.connect({ socket, host, ...(net.isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}), ALPNProtocols: ["http/1.1"] }));
          }, (error) => done(error));
          return undefined;
        }
      });
    }
    request.once("response", resolve);
    request.once("error", (error) => {
      if (error?.name === "AbortError") return reject(error);
      const through = proxy ? ` through the proxy ${proxy.protocol}//${proxy.host}` : "";
      reject(new Error(/^the proxy /.test(String(error?.message)) ? error.message : `${url.host} could not be reached${through}: ${error?.code || error?.message}`));
    });
    request.end(body);
  });
}

async function openUrl(target, { method = "GET", headers = {}, body, env = process.env, signal, ca } = {}) {
  let url = new URL(String(target));
  let verb = method;
  let payload = body;
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${url.href} is not an http(s) address.`);
    const response = await requestOnce(url, { method: verb, headers, env, signal, ca, body: payload });
    const location = response.headers.location;
    if (!REDIRECTS.has(response.statusCode) || !location) return { status: response.statusCode, headers: response.headers, body: response, url: url.href };
    response.resume();
    if (hop >= MAX_REDIRECTS) throw new Error(`${target} redirected more than ${MAX_REDIRECTS} times.`);
    url = new URL(location, url);
    if ((response.statusCode === 303 && verb !== "HEAD") || ((response.statusCode === 301 || response.statusCode === 302) && verb === "POST")) {
      verb = "GET";
      payload = undefined;
    }
  }
}

/**
 * What `proxyFetch` asks for, as `fetch` does. A registry document is a
 * tenth of its size compressed — typescript's is 15.8 MB as sent plain and
 * 2.0 MB gzipped — and the supply-chain hook has three seconds for it.
 * The download asks for none: a `Range` resumes
 * bytes of the file itself.
 */
const ACCEPT_ENCODING = "gzip, deflate, br";
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * A body decoded by its `content-encoding`, the last coding first. A stream
 * cut short of its trailer gives what arrived, as `fetch` does; "deflate"
 * comes with the zlib wrapper or, from some servers, without it.
 */
async function decodeBody(bytes, encoding) {
  const codings = String(encoding ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name && name !== "identity");
  let result = bytes;
  for (const coding of codings.reverse()) {
    if (!result.length) break;
    if (coding === "gzip" || coding === "x-gzip") result = await gunzip(result, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    else if (coding === "deflate") result = await ((result[0] & 0x0f) === 0x08 ? inflate : inflateRaw)(result, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    else if (coding === "br") result = await brotliDecompress(result, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    else throw new Error(`the answer came ${coding}-encoded, which was not asked for`);
  }
  return result;
}

async function readBody(body, signal) {
  const chunks = [];
  const stop = () => body.destroy(signal.reason);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * The part of `fetch` the supply-chain check uses, through the proxy. A
 * deadline from `AbortSignal.timeout` rejects with its TimeoutError, as
 * `fetch` does, and answers come compressed and are decoded, as `fetch` does
 * them. Same contract as the server's `proxyFetch`.
 *
 * @param {string|URL} target
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal, env?: Record<string, string|undefined>, ca?: string|Buffer|Array<string|Buffer> }} [init]
 *   `ca`: authorities to trust instead of Node's — the host's and an `https://` proxy's; a hook leaves it out.
 */
export async function proxyFetch(target, { method = "GET", headers = {}, body, signal, env = process.env, ca } = {}) {
  const rethrow = (error) => {
    throw signal?.aborted && signal.reason?.name === "TimeoutError" ? signal.reason : error;
  };
  const response = await openUrl(target, { method, headers: { "accept-encoding": ACCEPT_ENCODING, ...headers }, body, signal, env, ca }).catch(rethrow);
  let consumed = null;
  const bytes = () => {
    consumed ??= readBody(response.body, signal).then((raw) => decodeBody(raw, response.headers["content-encoding"])).catch(rethrow);
    return consumed;
  };
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    url: response.url,
    headers: {
      get: (name) => {
        const value = response.headers[String(name).toLowerCase()];
        return value === undefined ? null : [value].flat().join(", ");
      }
    },
    text: async () => (await bytes()).toString("utf8"),
    json: async () => JSON.parse((await bytes()).toString("utf8"))
  };
}
