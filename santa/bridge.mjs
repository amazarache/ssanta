#!/usr/bin/env node
// stdio bridge to the game server, for opencode installations that cannot use a remote MCP server
// directly, or that must go through an HTTP proxy.
//
// opencode starts this file as a local MCP server. Each JSON-RPC message from stdin is posted to the
// address in santa-server.txt with the player's token, and the reply is written to stdout.
// No dependencies: Node 18 or newer (or Bun).
//
// Proxy: taken from HTTPS_PROXY / https_proxy (HTTP_PROXY / ALL_PROXY as fallback), or from a
// one-line file .santa-proxy in the repository root. NO_PROXY is honoured. For a proxy that
// re-signs TLS, point NODE_EXTRA_CA_CERTS at the company CA file.

import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readLine = (name) => {
  try {
    return readFileSync(join(root, name), "utf8").trim();
  } catch {
    return "";
  }
};

const target = new URL(process.env.SANTA_URL || readLine("santa-server.txt"));
const TIMEOUT_MS = 30_000;

function proxyFor(url) {
  const env = process.env;
  const noProxy = (env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (noProxy.some((n) => n === "*" || host === n.replace(/^\./, "") || host.endsWith("." + n.replace(/^\./, "")))) return null;
  const fromEnv =
    url.protocol === "https:"
      ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy
      : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  const raw = fromEnv || readLine(".santa-proxy");
  if (!raw) return null;
  return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
}

function proxyAuth(proxy) {
  if (!proxy.username) return {};
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "Proxy-Authorization": `Basic ${Buffer.from(cred).toString("base64")}` };
}

// Opens a TLS connection to the target through the proxy with CONNECT.
function tunnel(proxy, url) {
  return new Promise((resolve, reject) => {
    const port = url.port || 443;
    const lib = proxy.protocol === "https:" ? https : http;
    const req = lib.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${url.hostname}:${port}`,
      headers: { Host: `${url.hostname}:${port}`, ...proxyAuth(proxy) },
      timeout: TIMEOUT_MS,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`the proxy refused the connection (HTTP ${res.statusCode})`));
        return;
      }
      const secure = tls.connect({ socket, servername: url.hostname }, () => resolve(secure));
      secure.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the proxy did not answer in time")));
    req.on("error", reject);
    req.end();
  });
}

async function post(body) {
  const token = readLine(".santa-token");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Content-Length": Buffer.byteLength(body),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const proxy = proxyFor(target);
  const isHttps = target.protocol === "https:";
  let options = { method: "POST", headers, timeout: TIMEOUT_MS, agent: false };
  let lib = isHttps ? https : http;
  if (proxy && isHttps) {
    const socket = await tunnel(proxy, target);
    options = { ...options, host: target.hostname, port: target.port || 443, path: target.pathname + target.search, createConnection: () => socket };
  } else if (proxy) {
    // Plain HTTP target: ask the proxy for the absolute address.
    lib = proxy.protocol === "https:" ? https : http;
    options = {
      ...options,
      host: proxy.hostname,
      port: proxy.port || 80,
      path: target.href,
      headers: { ...headers, Host: target.host, ...proxyAuth(proxy) },
    };
  } else {
    options = { ...options, host: target.hostname, port: target.port || (isHttps ? 443 : 80), path: target.pathname + target.search };
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("the game server did not answer in time")));
    req.on("error", reject);
    req.end(body);
  });
}

// The server answers with JSON; an event stream is also accepted, in case a proxy or a later server version sends one.
function messages(res) {
  if (!res.text.trim()) return [];
  if (res.type.includes("text/event-stream")) {
    return res.text
      .split(/\r?\n\r?\n/)
      .map((ev) => ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
      .filter(Boolean)
      .map((d) => JSON.parse(d));
  }
  const parsed = JSON.parse(res.text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let pending = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  // One request at a time, in order.
  pending = pending.then(async () => {
    let id;
    try {
      id = JSON.parse(line).id;
      const res = await post(line);
      if (res.status >= 400) throw new Error(`the game server answered HTTP ${res.status}`);
      for (const m of messages(res)) send(m);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      process.stderr.write(`santa bridge: ${why}\n`);
      if (id !== undefined && id !== null) {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: `Cannot reach the game server at ${target.host}: ${why}` } });
      }
    }
  });
});
