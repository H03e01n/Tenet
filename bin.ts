import { renameSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";

// ============================================================
// Types and configuration
// ============================================================

type Mode = "sing-box" | "xray" | "mihomo";
type AnyObject = Record<string, any>;

interface Options {
  mode: Mode;
  inputs: string[];
  output: string;
  limit: number | null;
  concurrency: number;
  timeout: number;
  verbose: boolean;
  exec: boolean;
  protocols: string[];
  exitCountries: string[];
}

const DEFAULT_CONCURRENCY = 12;
const DEFAULT_TIMEOUT = 15_000;
const LOCATION_TIMEOUT = 12_000;

const options: Options = {
  mode: "sing-box",
  inputs: [],
  output: "",
  limit: null,
  concurrency: DEFAULT_CONCURRENCY,
  timeout: DEFAULT_TIMEOUT,
  verbose: false,
  exec: false,
  protocols: [],
  exitCountries: [],
};

const activeChildren = new Set<ChildProcess>();

// ============================================================
// ANSI Color Logging Utilities
// ============================================================

const kleur = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

let failedCount = 0;

const log = {
  info: (msg: string) =>
    console.log(`${kleur.cyan}  ·${kleur.reset} ${msg}`),
  ok: (msg: string) =>
    console.log(`${kleur.green}  ok${kleur.reset} ${msg}`),
  success: (msg: string) =>
    console.log(`${kleur.green}  ok${kleur.reset} ${msg}`),
  warn: (msg: string) =>
    console.log(`${kleur.yellow}  !!${kleur.reset} ${msg}`),
  error: (msg: string) =>
    console.log(`${kleur.red}  xx${kleur.reset} ${msg}`),
  step: (msg: string) =>
    console.log(`${kleur.bold}${kleur.cyan}==>${kleur.reset} ${msg}`),
  verbose: (msg: string) => {
    if (options.verbose) {
      console.log(`${kleur.gray}     ${msg}${kleur.reset}`);
    }
  },
};

process.on("SIGINT", () => {
  log.warn("\nAborting... Cleaning up active processes.");
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  process.exit(130);
});

// ============================================================
// CLI
// ============================================================

function usage(): never {
  console.log(`
${kleur.bold}Usage:${kleur.reset}
  bun run bin.ts [options] <input1> [input2 ...]

${kleur.bold}Inputs:${kleur.reset}
  Subscription links, local files, or URLs.
  Supported: Clash/mihomo YAML, JSON (Clash proxies / sing-box outbounds /
  Xray outbounds), base64 or plain share links (vmess/ss/trojan/vless/…).
  Mihomo mode always writes YAML.

${kleur.bold}Options:${kleur.reset}
  -s, --sing-box            Generate sing-box config (default port: 2080)
  -x, --xray                Generate Xray config (default port: 10808)
  -m, --mihomo              Use Mihomo core and config (default port: 7890)
  -p, --protocol <list>     Filter protocols before test (e.g. vless,ss)
  -E, --exit <list>         Filter tested exit countries after test (e.g. us,de)
  -n, --limit <number>      Maximum successful nodes (triggers early stopping)
  -c, --concurrency <n>     Parallel tests (default: ${DEFAULT_CONCURRENCY})
  -o, --output <file>       Output filename
  -t, --timeout <ms>        Per-node location timeout
  -e, --exec                Execute the binary immediately with generated config
  -v, --verbose             Show concise activity logs
  -h, --help                Show this help

${kleur.bold}Examples:${kleur.reset}
  bun run bin.ts -v --protocol vless,ss --exit us,de https://.../sub.yaml
  bun run bin.ts -s -v config.json
  bun run bin.ts -m -v xray.json -o mihomo.yaml
  bun run bin.ts -s -v -e
`);
  process.exit(0);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") usage();

    if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
      continue;
    }

    if (arg === "-e" || arg === "--exec") {
      options.exec = true;
      continue;
    }

    if (arg === "-s" || arg === "--sing-box") {
      options.mode = "sing-box";
      continue;
    }

    if (arg === "-x" || arg === "--xray") {
      options.mode = "xray";
      continue;
    }

    if (arg === "-m" || arg === "--mihomo") {
      options.mode = "mihomo";
      continue;
    }

    const readValue = (name: string): string => {
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value after ${name}`);
      }
      return value;
    };

    if (arg === "-p" || arg === "--protocol") {
      const val = readValue(arg);
      options.protocols.push(
        ...val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
      continue;
    }
    if (arg.startsWith("--protocol=")) {
      const val = arg.slice("--protocol=".length);
      options.protocols.push(
        ...val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
      continue;
    }

    if (arg === "-E" || arg === "--exit") {
      const val = readValue(arg);
      options.exitCountries.push(
        ...val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
      continue;
    }
    if (arg.startsWith("--exit=")) {
      const val = arg.slice("--exit=".length);
      options.exitCountries.push(
        ...val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
      continue;
    }

    if (arg === "-n" || arg === "--limit") {
      options.limit = parsePositiveInteger(readValue(arg), "Limit");
      continue;
    }

    if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(
        arg.slice("--limit=".length),
        "Limit",
      );
      continue;
    }

    if (arg === "-c" || arg === "--concurrency") {
      options.concurrency = parsePositiveInteger(readValue(arg), "Concurrency");
      continue;
    }

    if (arg.startsWith("--concurrency=")) {
      options.concurrency = parsePositiveInteger(
        arg.slice("--concurrency=".length),
        "Concurrency",
      );
      continue;
    }

    if (arg === "--timeout" || arg === "-t") {
      options.timeout = parsePositiveInteger(readValue(arg), "Timeout");
      continue;
    }

    if (arg.startsWith("--timeout=") || arg.startsWith("-t=")) {
      const val = arg.startsWith("--timeout=")
        ? arg.slice("--timeout=".length)
        : arg.slice("-t=".length);
      options.timeout = parsePositiveInteger(val, "Timeout");
      continue;
    }

    if (arg === "-o" || arg === "--output") {
      options.output = readValue(arg);
      continue;
    }

    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      if (!options.output) throw new Error("Missing output filename");
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    options.inputs.push(arg);
  }

  if (options.inputs.length === 0) {
    if (existsSync("sub.txt")) {
      options.inputs.push("sub.txt");
    } else {
      usage();
    }
  }

  if (!options.output) {
    options.output =
      options.mode === "xray"
        ? "xry.json"
        : options.mode === "mihomo"
          ? "mihomo.yaml"
          : "xyz.json";
  }

  if (options.mode === "mihomo") {
    if (!/\.(ya?ml)$/i.test(options.output)) {
      options.output = options.output.replace(/\.json$/i, "") + ".yaml";
    }
  } else if (!/\.json$/i.test(options.output)) {
    options.output = options.output.replace(/\.ya?ml$/i, "") + ".json";
  }
}

try {
  parseArgs(Bun.argv.slice(2));
} catch (error) {
  log.error(`Argument error: ${(error as Error).message}`);
  process.exit(1);
}

function resolveBinary(mode: Mode): string {
  const candidates =
    mode === "xray"
      ? ["xray"]
      : mode === "mihomo"
        ? ["mihomo", "clash-meta", "clash"]
        : ["sbx", "sing-box"];
  for (const name of candidates) {
    try {
      const r = Bun.spawnSync(["which", name], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0) return name;
    } catch {}
  }
  return candidates[0];
}

const binary = resolveBinary(options.mode);
const listenPort =
  options.mode === "mihomo" ? 7890 : options.mode === "sing-box" ? 2080 : 10808;

// Enhanced Startup Logging with Active Filters Display
log.step(
  `${options.mode}  binary=${binary}  port=${listenPort}  workers=${options.concurrency}` +
    (options.limit != null ? `  limit=${options.limit}` : "") +
    `  timeout=${options.timeout}ms`,
);
log.info(`output ${options.output}`);
if (options.protocols.length > 0) {
  log.info(`filter protocol -> [${options.protocols.join(", ")}]`);
}
if (options.exitCountries.length > 0) {
  log.info(`filter exit country -> [${options.exitCountries.join(", ")}]`);
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBase64(value: string): string | null {
  try {
    const normalized = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/\s/g, "");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (!decoded || decoded.includes("\0")) return null;
    return decoded.trim();
  } catch {
    return null;
  }
}

function tryDecodeBase64Subscription(content: string): string {
  const trimmed = content.trim();
  if (
    trimmed.includes("proxies:") ||
    trimmed.includes("://") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    return trimmed;
  }
  const decoded = decodeBase64(trimmed);
  if (decoded) {
    return decoded;
  }
  return trimmed;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function applyFinalTag(outbound: AnyObject, newTag: string): void {
  if (options.mode === "mihomo") {
    outbound.name = newTag;
    delete outbound.tag;
  } else {
    outbound.tag = newTag;
    delete outbound.name;
  }
}

const protocolCounters = new Map<string, number>();

function nextTempTag(protocol: string): string {
  const key = protocol.toLowerCase().replace(/[^a-z0-9]+/g, "") || "node";
  const alias: Record<string, string> = {
    ss: "ss",
    shadowsocks: "ss",
    hy2: "hysteria2",
    hysteria2: "hysteria2",
    vmess: "vmess",
    vless: "vless",
    trojan: "trojan",
    tuic: "tuic",
  };
  const base = alias[key] || key;
  const n = (protocolCounters.get(base) || 0) + 1;
  protocolCounters.set(base, n);
  return `${base}${n}`;
}

function validPort(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function makeSignature(parts: unknown[]): string {
  return parts
    .map((part) => String(part ?? ""))
    .join("|")
    .toLowerCase();
}

function getXrayTransport(
  network: string | null | undefined,
  path: string | null | undefined,
  host: string | null | undefined,
  serviceName?: string | null,
): AnyObject {
  if (network === "ws") {
    return {
      network: "ws",
      wsSettings: {
        path: path || "/",
        headers: host ? { Host: host } : undefined,
      },
    };
  }
  if (network === "grpc") {
    return {
      network: "grpc",
      grpcSettings: { serviceName: serviceName || path || "" },
    };
  }
  return { network: network || "tcp" };
}

// ============================================================
// Sing-Box Outbound Formatter
// ============================================================

function truthyTls(value: unknown): boolean {
  return value === true || value === "tls" || value === "reality";
}

function nodeInsecure(outbound: AnyObject): boolean {
  if (outbound["skip-cert-verify"] === false || outbound.insecure === false) {
    return false;
  }
  if (outbound["skip-cert-verify"] === true || outbound.insecure === true) {
    return true;
  }
  return true;
}

function buildSingBoxTls(outbound: AnyObject): AnyObject | undefined {
  const security = String(outbound.security || "").toLowerCase();
  const wantsTls =
    truthyTls(outbound.tls) ||
    security === "tls" ||
    security === "reality" ||
    ["trojan", "hysteria2", "hy2", "tuic"].includes(
      String(outbound.type || "").toLowerCase(),
    );

  if (!wantsTls && security !== "reality") return undefined;

  const sni =
    outbound.servername ||
    outbound.sni ||
    outbound.peer ||
    outbound.server ||
    "";
  const tls: AnyObject = {
    enabled: true,
    server_name: sni,
    insecure: nodeInsecure(outbound),
  };
  if (outbound.fp || outbound.fingerprint) {
    tls.utls = { enabled: true, fingerprint: outbound.fp || outbound.fingerprint };
  }
  const isReality =
    security === "reality" ||
    outbound["client-fingerprint"] ||
    outbound.publicKey ||
    outbound["public-key"] ||
    outbound.pbk;
  if (isReality) {
    tls.reality = {
      enabled: true,
      public_key:
        outbound.publicKey || outbound["public-key"] || outbound.pbk || "",
      short_id: outbound.shortId || outbound["short-id"] || outbound.sid || "",
    };
  }
  return tls;
}

function buildSingBoxTransport(outbound: AnyObject): AnyObject | undefined {
  const network = String(
    outbound.network || outbound.net || "tcp",
  ).toLowerCase();
  if (network === "ws" || network === "websocket") {
    const path =
      outbound.path ||
      outbound["ws-opts"]?.path ||
      outbound.ws_opts?.path ||
      "/";
    const host =
      outbound.host ||
      outbound["ws-opts"]?.headers?.Host ||
      outbound["ws-opts"]?.headers?.host ||
      undefined;
    const transport: AnyObject = { type: "ws", path };
    if (host) transport.headers = { Host: host };
    return transport;
  }
  if (network === "grpc") {
    const serviceName =
      outbound.serviceName ||
      outbound["grpc-opts"]?.["grpc-service-name"] ||
      outbound.path ||
      "";
    return { type: "grpc", service_name: serviceName };
  }
  if (network === "http" || network === "h2") {
    const path = outbound.path || "/";
    const host = outbound.host;
    const transport: AnyObject = { type: "http", path: [path] };
    if (host) transport.host = Array.isArray(host) ? host : [host];
    return transport;
  }
  return undefined;
}

function formatSingBoxOutbound(outbound: AnyObject): AnyObject {
  let type = String(outbound.type || "").toLowerCase();
  if (type === "ss") type = "shadowsocks";
  if (type === "hy2") type = "hysteria2";

  const formatted: AnyObject = {
    type,
    tag: outbound.tag || outbound.name,
    server: outbound.server,
    server_port: Number(outbound.port || outbound.server_port),
  };

  if (outbound.uuid) formatted.uuid = outbound.uuid;
  if (outbound.password) formatted.password = outbound.password;
  if (outbound.flow) formatted.flow = outbound.flow;

  if (type === "vmess") {
    formatted.security = outbound.cipher || outbound.security || outbound.scy || "auto";
    if (outbound.alterId !== undefined || outbound.alter_id !== undefined) {
      formatted.alter_id = Number(outbound.alterId ?? outbound.alter_id ?? 0);
    }
  } else if (type === "shadowsocks") {
    const method = outbound.method || outbound.cipher;
    if (method) formatted.method = method;
  } else {
    const cipherVal = outbound.method || outbound.cipher;
    if (cipherVal && type !== "vless") formatted.method = cipherVal;
  }

  if (type === "hysteria2") {
    const up = outbound.up_mbps ?? outbound.up ?? outbound["up-mbps"];
    const down = outbound.down_mbps ?? outbound.down ?? outbound["down-mbps"];
    if (up != null && up !== "") formatted.up_mbps = Number(up) || undefined;
    if (down != null && down !== "") formatted.down_mbps = Number(down) || undefined;
    if (outbound.ports) formatted.ports = outbound.ports;
    if (outbound.obfs) {
      if (typeof outbound.obfs === "object") {
        formatted.obfs = {
          type: outbound.obfs.type || "salamander",
          password: outbound.obfs.password || outbound["obfs-password"] || "",
        };
      } else {
        formatted.obfs = {
          type: String(outbound.obfs) || "salamander",
          password: outbound["obfs-password"] || outbound.obs_password || "",
        };
      }
    }
  }

  if (type === "tuic") {
    const cc =
      outbound.congestion_control ||
      outbound["congestion-controller"] ||
      outbound.congestion;
    if (cc) formatted.congestion_control = cc;
    const relay =
      outbound.udp_relay_mode || outbound["udp-relay-mode"] || outbound.udpRelayMode;
    if (relay) formatted.udp_relay_mode = relay;
    const zrtt =
      outbound.zero_rtt_handshake ?? outbound["reduce-rtt"] ?? outbound.reduce_rtt;
    if (zrtt !== undefined) formatted.zero_rtt_handshake = Boolean(zrtt);
    if (outbound.heartbeat != null) formatted.heartbeat = outbound.heartbeat;
  }

  const tls = buildSingBoxTls(outbound);
  if (tls) {
    const alpn = outbound.alpn;
    if (alpn != null) {
      tls.alpn = Array.isArray(alpn)
        ? alpn
        : String(alpn)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    formatted.tls = tls;
  }

  const transport = buildSingBoxTransport(outbound);
  if (transport) formatted.transport = transport;

  const reserved = new Set([
    "type",
    "tag",
    "name",
    "server",
    "port",
    "server_port",
    "uuid",
    "password",
    "cipher",
    "method",
    "security",
    "scy",
    "flow",
    "alterId",
    "alter_id",
    "tls",
    "servername",
    "sni",
    "peer",
    "network",
    "net",
    "path",
    "host",
    "fp",
    "fingerprint",
    "publicKey",
    "public-key",
    "pbk",
    "shortId",
    "short-id",
    "sid",
    "ws-opts",
    "ws_opts",
    "grpc-opts",
    "grpc_opts",
    "reality-opts",
    "skip-cert-verify",
    "insecure",
    "client-fingerprint",
    "serviceName",
    "up",
    "down",
    "up_mbps",
    "down_mbps",
    "up-mbps",
    "down-mbps",
    "obfs",
    "obfs-password",
    "obfs_password",
    "obfsPassword",
    "ports",
    "mport",
    "alpn",
    "congestion_control",
    "congestion-controller",
    "congestion",
    "udp_relay_mode",
    "udp-relay-mode",
    "udpRelayMode",
    "zero_rtt_handshake",
    "reduce-rtt",
    "reduce_rtt",
    "zeroRtt",
    "heartbeat",
    "auth",
  ]);
  for (const key of Object.keys(outbound)) {
    if (!reserved.has(key) && formatted[key] === undefined) {
      formatted[key] = outbound[key];
    }
  }

  return formatted;
}

// ============================================================
// Process runner using Bun.spawn
// ============================================================

async function runCommand(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    activeChildren.add(proc as unknown as ChildProcess);

    let settled = false;
    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(proc as unknown as ChildProcess);

      if (error) {
        reject(error);
      } else {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        resolve({ stdout, stderr });
      }
    };

    proc.exited.then(async (code) => {
      if (code === 0) {
        finish();
      } else {
        const stderr = await new Response(proc.stderr).text();
        finish(
          new Error(`${command} exited with code ${code}\n${stderr.trim()}`),
        );
      }
    });

    const timer = setTimeout(() => {
      proc.kill(15);
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill(9);
      }, 1000).unref();
      finish(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);
  });
}

// ============================================================
// YAML & Subscription / JSON Loading
// ============================================================

async function fetchUrlContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return tryDecodeBase64Subscription(text);
  } finally {
    clearTimeout(timer);
  }
}

function unquoteYamlScalar(raw: string): unknown {
  let val = raw.trim();
  if (!val) return "";
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
    return val;
  }
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null" || val === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  if (val.startsWith("{") && val.endsWith("}")) {
    const obj: AnyObject = {};
    const inner = val.slice(1, -1).trim();
    if (!inner) return obj;
    for (const part of inner.split(",")) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim().replace(/^["']|["']$/g, "");
      const v = unquoteYamlScalar(part.slice(idx + 1));
      obj[k] = v;
    }
    return obj;
  }
  return val;
}

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function parseMihomoYamlProxies(yamlContent: string): AnyObject[] {
  const proxies: AnyObject[] = [];
  const lines = yamlContent.split(/\r?\n/);
  let inProxiesSection = false;
  let proxiesIndent = -1;
  let currentProxy: AnyObject | null = null;
  const nestStack: { indent: number; obj: AnyObject; key?: string }[] = [];

  const flushProxy = () => {
    if (currentProxy) {
      proxies.push(currentProxy);
      currentProxy = null;
    }
    nestStack.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!inProxiesSection) {
      if (trimmed === "proxies:" || trimmed.startsWith("proxies:")) {
        inProxiesSection = true;
        proxiesIndent = indentOf(line);
        continue;
      }
      continue;
    }

    const ind = indentOf(line);

    if (ind <= proxiesIndent && !trimmed.startsWith("-") && /^[A-Za-z0-9_-]+:/.test(trimmed)) {
      flushProxy();
      inProxiesSection = false;
      continue;
    }

    if (trimmed.startsWith("-") && (proxiesIndent < 0 || ind <= proxiesIndent + 2)) {
      flushProxy();
      currentProxy = {};
      nestStack.length = 0;
      const rest = trimmed.slice(1).trim();
      if (rest.includes(":")) {
        const colonIdx = rest.indexOf(":");
        const key = rest.slice(0, colonIdx).trim();
        const rawVal = rest.slice(colonIdx + 1).trim();
        if (rawVal === "" || rawVal === "|" || rawVal === ">") {
          const child: AnyObject = {};
          currentProxy[key] = child;
          nestStack.push({ indent: ind, obj: currentProxy, key });
          nestStack.push({ indent: ind + 2, obj: child });
        } else {
          currentProxy[key] = unquoteYamlScalar(rawVal);
        }
      }
      continue;
    }

    if (!currentProxy) continue;

    if (!trimmed.includes(":")) continue;
    const colonIdx = trimmed.indexOf(":");
    const key = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).trim();

    while (nestStack.length > 1 && ind < nestStack[nestStack.length - 1].indent) {
      nestStack.pop();
    }

    const target =
      nestStack.length > 0 ? nestStack[nestStack.length - 1].obj : currentProxy;

    if (rawVal === "" || rawVal === "|" || rawVal === ">") {
      const child: AnyObject = {};
      target[key] = child;
      nestStack.push({ indent: ind + 2, obj: child, key });
    } else {
      target[key] = unquoteYamlScalar(rawVal);
    }
  }

  flushProxy();
  return proxies;
}

const PROXY_TYPES = new Set([
  "vmess",
  "vless",
  "trojan",
  "ss",
  "shadowsocks",
  "hysteria2",
  "hy2",
  "tuic",
]);

function normalizeJsonProxy(raw: AnyObject): AnyObject | null {
  if (!raw || typeof raw !== "object") return null;

  if (raw.protocol && !raw.type) {
    const protocol = String(raw.protocol).toLowerCase();
    if (!PROXY_TYPES.has(protocol) && protocol !== "shadowsocks") return null;

    const out: AnyObject = {
      type: protocol === "shadowsocks" ? "ss" : protocol,
      tag: raw.tag,
      name: raw.tag || raw.name,
    };

    const settings = raw.settings || {};
    if (protocol === "vmess" || protocol === "vless") {
      const vnext = settings.vnext?.[0];
      if (!vnext) return null;
      out.server = vnext.address;
      out.port = vnext.port;
      const user = vnext.users?.[0] || {};
      out.uuid = user.id;
      out.id = user.id;
      if (user.alterId !== undefined) out.alterId = user.alterId;
      if (user.security) out.cipher = user.security;
      if (user.flow) out.flow = user.flow;
      if (user.encryption) out.encryption = user.encryption;
    } else if (protocol === "trojan" || protocol === "shadowsocks") {
      const srv = settings.servers?.[0];
      if (!srv) return null;
      out.server = srv.address;
      out.port = srv.port;
      out.password = srv.password;
      if (srv.method) out.method = srv.method;
      if (srv.cipher) out.cipher = srv.cipher;
    } else {
      return null;
    }

    const stream = raw.streamSettings || {};
    if (stream.network) out.network = stream.network;
    if (stream.security) out.security = stream.security;
    if (stream.tlsSettings) {
      out.sni = stream.tlsSettings.serverName;
      out.servername = stream.tlsSettings.serverName;
      out.fp = stream.tlsSettings.fingerprint;
      if (stream.tlsSettings.allowInsecure !== undefined) {
        out.insecure = stream.tlsSettings.allowInsecure;
      }
    }
    if (stream.realitySettings) {
      out.security = "reality";
      out.publicKey = stream.realitySettings.publicKey;
      out.pbk = stream.realitySettings.publicKey;
      out.shortId = stream.realitySettings.shortId;
      out.sid = stream.realitySettings.shortId;
      out.sni = stream.realitySettings.serverName || out.sni;
      out.fp = stream.realitySettings.fingerprint || out.fp;
    }
    if (stream.wsSettings) {
      out.path = stream.wsSettings.path;
      out.host =
        stream.wsSettings.headers?.Host || stream.wsSettings.headers?.host;
    }
    if (stream.grpcSettings) {
      out.serviceName = stream.grpcSettings.serviceName;
      out.path = stream.grpcSettings.serviceName || out.path;
    }
    return out;
  }

  const type = String(raw.type || "").toLowerCase();
  if (!PROXY_TYPES.has(type)) return null;

  const out: AnyObject = { ...raw };
  if (out.server_port != null && out.port == null) {
    out.port = out.server_port;
  }
  if (type === "shadowsocks") out.type = "ss";
  if (type === "hy2") out.type = "hysteria2";
  return out;
}

function parseJsonProxies(jsonContent: string): AnyObject[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonContent);
  } catch {
    return [];
  }

  let candidates: AnyObject[] = [];

  if (Array.isArray(data)) {
    candidates = data.filter((x) => x && typeof x === "object");
  } else if (data && typeof data === "object") {
    const obj = data as AnyObject;
    if (Array.isArray(obj.proxies)) {
      candidates = obj.proxies;
    } else if (Array.isArray(obj.outbounds)) {
      candidates = obj.outbounds;
    } else if (obj.type || obj.protocol) {
      candidates = [obj];
    }
  }

  const result: AnyObject[] = [];
  for (const item of candidates) {
    const normalized = normalizeJsonProxy(item);
    if (normalized) result.push(normalized);
  }
  return result;
}

function looksLikeJson(content: string, inputPath: string): boolean {
  if (/\.json$/i.test(inputPath)) return true;
  const trimmed = content.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

async function loadInputs(): Promise<{
  rawLinks: string[];
  mihomoObjects: AnyObject[];
}> {
  const rawLinks: string[] = [];
  const mihomoObjects: AnyObject[] = [];

  log.step(`load ${options.inputs.length} source(s)`);
  for (let i = 0; i < options.inputs.length; i++) {
    const input = options.inputs[i];
    log.info(`[${i + 1}/${options.inputs.length}] ${input}`);

    let rawContent = "";
    if (/^https?:\/\//i.test(input)) {
      log.verbose(`GET ${input}`);
      rawContent = await fetchUrlContent(input);
    } else {
      const file = Bun.file(input);
      if (!(await file.exists())) {
        throw new Error(`Local input file does not exist: ${input}`);
      }
      const fileText = await file.text();
      rawContent = tryDecodeBase64Subscription(fileText);
    }

    const isYaml =
      input.endsWith(".yaml") ||
      input.endsWith(".yml") ||
      (rawContent.includes("proxies:") && !looksLikeJson(rawContent, input));

    const isJson = !isYaml && looksLikeJson(rawContent, input);

    if (isYaml) {
      const parsed = parseMihomoYamlProxies(rawContent);
      log.verbose(`yaml proxies extracted: ${parsed.length}`);
      mihomoObjects.push(...parsed);
    } else if (isJson) {
      const parsed = parseJsonProxies(rawContent);
      log.verbose(`json proxies extracted: ${parsed.length}`);
      mihomoObjects.push(...parsed);
    } else {
      const lines = rawContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      for (const line of lines) {
        if (/^https?:\/\//i.test(line)) {
          log.verbose(`nested GET ${line}`);
          try {
            const subContent = await fetchUrlContent(line);
            const trimmed = subContent.trim();
            if (trimmed.includes("proxies:") && !looksLikeJson(trimmed, line)) {
              const parsed = parseMihomoYamlProxies(trimmed);
              log.verbose(`nested yaml proxies: ${parsed.length}`);
              mihomoObjects.push(...parsed);
            } else if (looksLikeJson(trimmed, line)) {
              const parsed = parseJsonProxies(trimmed);
              log.verbose(`nested json proxies: ${parsed.length}`);
              mihomoObjects.push(...parsed);
            } else if (trimmed) {
              const nestedLines = trimmed
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith("#"));
              let added = 0;
              for (const nested of nestedLines) {
                if (!nested.includes("://") && !nested.startsWith("{")) {
                  const decoded = decodeBase64(nested);
                  if (
                    decoded &&
                    (decoded.includes("://") || decoded.startsWith("{"))
                  ) {
                    for (const part of decoded.split(/\r?\n/)) {
                      const p = part.trim();
                      if (p) {
                        rawLinks.push(p);
                        added++;
                      }
                    }
                    continue;
                  }
                }
                rawLinks.push(nested);
                added++;
              }
              log.verbose(`nested links added: ${added}`);
            }
          } catch (err) {
            log.warn(`fetch failed ${line}: ${(err as Error).message}`);
          }
        } else {
          let content = line;
          if (!content.includes("://") && !content.startsWith("{")) {
            const decoded = decodeBase64(content);
            if (
              decoded &&
              (decoded.includes("://") || decoded.startsWith("{"))
            ) {
              for (const part of decoded.split(/\r?\n/)) {
                const p = part.trim();
                if (p) rawLinks.push(p);
              }
              continue;
            }
          }
          if (content) rawLinks.push(content);
        }
      }
    }
  }

  log.ok(
    `loaded  yaml/json=${mihomoObjects.length}  links=${rawLinks.length}`,
  );
  return { rawLinks, mihomoObjects };
}

// ============================================================
// Outbound Builders & Protocol Parsers
// ============================================================

function buildVmess(data: AnyObject, tag: string): AnyObject | null {
  const server = String(data.add || data.server || "");
  const port = validPort(data.port || data.server_port);
  const uuid = String(data.id || data.uuid || "");

  if (!server || !port || !uuid) return null;

  const network = String(data.net || data.network || "tcp");
  const tls = data.tls === true || data.tls === "tls";
  const security = String(data.scy || data.cipher || "auto");
  const alterId = Number.parseInt(data.aid || data.alterId || "0", 10) || 0;

  if (options.mode === "sing-box" || options.mode === "mihomo") {
    const outbound: AnyObject = {
      [options.mode === "mihomo" ? "name" : "tag"]: tag,
      type: "vmess",
      server,
      port,
      uuid,
      alterId,
      cipher: security,
      network,
      path: data.path || "/",
      host: data.host,
      sni: data.sni || data.servername || server,
      tls: tls || undefined,
      insecure: data["skip-cert-verify"] ?? data.insecure,
      fp: data.fp || data.fingerprint,
    };
    if (network === "grpc") {
      outbound.serviceName = data.serviceName || data.path || "";
    }
    if (options.mode === "mihomo") {
      if (tls) outbound.tls = true;
      if (network === "ws") {
        outbound["ws-opts"] = {
          path: data.path || "/",
          headers: data.host ? { Host: data.host } : undefined,
        };
      } else if (network === "grpc") {
        outbound["grpc-opts"] = {
          "grpc-service-name": data.serviceName || data.path || "",
        };
      }
      if (data["skip-cert-verify"] !== undefined) {
        outbound["skip-cert-verify"] = data["skip-cert-verify"];
      }
    }
    return outbound;
  }

  const streamSettings: AnyObject = { network, security: tls ? "tls" : "none" };
  if (tls) {
    streamSettings.tlsSettings = {
      serverName: data.sni || data.servername || server,
      fingerprint: data.fp || "chrome",
    };
  }

  Object.assign(
    streamSettings,
    getXrayTransport(network, data.path, data.host, data.serviceName),
  );

  return {
    protocol: "vmess",
    tag,
    settings: {
      vnext: [
        { address: server, port, users: [{ id: uuid, alterId, security }] },
      ],
    },
    streamSettings,
  };
}

function parseShadowsocks(urlString: string): AnyObject | null {
  const raw = urlString.slice("ss://".length);
  const withoutFragment = raw.split("#")[0];
  const withoutQuery = withoutFragment.split("?")[0];

  let serverPart = "";
  let method = "";
  let password = "";

  if (withoutQuery.includes("@")) {
    const at = withoutQuery.lastIndexOf("@");
    const userInfo = withoutQuery.slice(0, at);
    serverPart = withoutQuery.slice(at + 1);

    const decoded = decodeBase64(userInfo);
    const credentials = decoded || safeDecode(userInfo);
    const colon = credentials.indexOf(":");
    if (colon >= 0) {
      method = credentials.slice(0, colon);
      password = credentials.slice(colon + 1);
    }
  } else {
    const decoded = decodeBase64(withoutQuery);
    if (!decoded || !decoded.includes("@")) return null;
    const at = decoded.lastIndexOf("@");
    const credentials = decoded.slice(0, at);
    serverPart = decoded.slice(at + 1);
    const colon = credentials.indexOf(":");
    if (colon < 0) return null;
    method = credentials.slice(0, colon);
    password = credentials.slice(colon + 1);
  }

  if (!serverPart || !method || !password) return null;

  try {
    const address = new URL(`http://${serverPart}`);
    const server = address.hostname;
    const port = validPort(address.port);
    if (!server || !port) return null;
    return { server, port, method, password };
  } catch {
    return null;
  }
}

function buildShadowsocks(data: AnyObject, tag: string): AnyObject {
  const server = data.server || data.add;
  const port = validPort(data.port || data.server_port);
  const method = data.method || data.cipher;
  const password = data.password;

  if (options.mode === "mihomo") {
    return {
      name: tag,
      type: "ss",
      server,
      port,
      cipher: method,
      password,
    };
  }

  if (options.mode === "sing-box") {
    return {
      tag,
      type: "shadowsocks",
      server,
      server_port: port,
      method,
      password,
    };
  }

  return {
    protocol: "shadowsocks",
    tag,
    settings: {
      servers: [{ address: server, port, method, password }],
    },
  };
}

function buildTrojan(data: AnyObject | URL, tag: string): AnyObject | null {
  let server: string,
    port: number | null,
    password: string,
    sni: string,
    network = "tcp",
    path = "/",
    host = "",
    fp = "chrome",
    insecure: unknown = undefined,
    pbk = "",
    sid = "",
    security = "tls";

  if (data instanceof URL) {
    server = data.hostname;
    port = validPort(data.port);
    password = safeDecode(data.username);
    const params = data.searchParams;
    sni = params.get("sni") || params.get("peer") || server;
    network = params.get("type") || params.get("network") || "tcp";
    path = params.get("path") || "/";
    host = params.get("host") || "";
    fp = params.get("fp") || "chrome";
    pbk = params.get("pbk") || "";
    sid = params.get("sid") || "";
    security = params.get("security") || (pbk ? "reality" : "tls");
    if (params.get("allowInsecure") === "1" || params.get("insecure") === "1") {
      insecure = true;
    }
  } else {
    server = data.server;
    port = validPort(data.port || data.server_port);
    password = data.password;
    sni = data.sni || data.servername || data.peer || server;
    network = String(data.network || data.net || "tcp");
    path = data.path || data["ws-opts"]?.path || "/";
    host = data.host || data["ws-opts"]?.headers?.Host || "";
    fp = data.fp || data.fingerprint || data["client-fingerprint"] || "chrome";
    pbk =
      data.pbk ||
      data.publicKey ||
      data["public-key"] ||
      data["reality-opts"]?.["public-key"] ||
      "";
    sid =
      data.sid ||
      data.shortId ||
      data["short-id"] ||
      data["reality-opts"]?.["short-id"] ||
      "";
    security = pbk ? "reality" : "tls";
    insecure = data["skip-cert-verify"] ?? data.insecure;
  }

  if (!server || !port || !password) return null;

  if (options.mode === "sing-box" || options.mode === "mihomo") {
    const outbound: AnyObject = {
      [options.mode === "mihomo" ? "name" : "tag"]: tag,
      type: "trojan",
      server,
      port,
      password,
      sni,
      tls: true,
      network,
      path,
      host: host || undefined,
      fp,
      security,
      insecure,
      publicKey: pbk || undefined,
      shortId: sid || undefined,
    };
    if (options.mode === "mihomo") {
      outbound["skip-cert-verify"] = insecure !== false;
      if (network === "ws") {
        outbound["ws-opts"] = {
          path,
          headers: host ? { Host: host } : undefined,
        };
      } else if (network === "grpc") {
        outbound["grpc-opts"] = { "grpc-service-name": path };
      }
      if (pbk) {
        outbound["reality-opts"] = { "public-key": pbk, "short-id": sid };
        outbound["client-fingerprint"] = fp;
      }
    }
    return outbound;
  }

  const streamSettings: AnyObject = {
    network,
    security: security === "reality" ? "reality" : "tls",
    tlsSettings: {
      serverName: sni,
      fingerprint: fp,
      allowInsecure: insecure !== false,
    },
  };
  if (security === "reality") {
    streamSettings.realitySettings = {
      publicKey: pbk,
      shortId: sid,
      serverName: sni,
      fingerprint: fp,
    };
  }
  Object.assign(streamSettings, getXrayTransport(network, path, host, path));

  return {
    protocol: "trojan",
    tag,
    settings: { servers: [{ address: server, port, password }] },
    streamSettings,
  };
}

function buildVless(data: AnyObject | URL, tag: string): AnyObject | null {
  let server: string,
    port: number | null,
    uuid: string,
    security: string,
    sni: string,
    flow: string;

  if (data instanceof URL) {
    server = data.hostname;
    port = validPort(data.port);
    uuid = safeDecode(data.username);
    const params = data.searchParams;
    security = params.get("security") || "none";
    sni = params.get("sni") || server;
    flow = params.get("flow") || "";
  } else {
    server = data.server;
    port = validPort(data.port || data.server_port);
    uuid = data.uuid || data.id;
    security = data.security || "none";
    sni = data.sni || data.servername || server;
    flow = data.flow || "";
  }

  if (!server || !port || !uuid) return null;

  let network = "tcp";
  let path = "/";
  let host = "";
  let fp = "";
  let pbk = "";
  let sid = "";
  let insecure: unknown = undefined;

  if (data instanceof URL) {
    const params = data.searchParams;
    network = params.get("type") || params.get("network") || "tcp";
    path = params.get("path") || params.get("serviceName") || "/";
    host = params.get("host") || "";
    fp = params.get("fp") || "";
    pbk = params.get("pbk") || "";
    sid = params.get("sid") || "";
    if (params.get("allowInsecure") === "1") insecure = true;
    if (pbk && security === "none") security = "reality";
  } else {
    network = String(data.network || data.net || "tcp");
    path = data.path || data.serviceName || data["ws-opts"]?.path || "/";
    host = data.host || data["ws-opts"]?.headers?.Host || "";
    fp = data.fp || data.fingerprint || data["client-fingerprint"] || "";
    pbk =
      data.pbk ||
      data.publicKey ||
      data["public-key"] ||
      data["reality-opts"]?.["public-key"] ||
      "";
    sid =
      data.sid ||
      data.shortId ||
      data["short-id"] ||
      data["reality-opts"]?.["short-id"] ||
      "";
    insecure = data["skip-cert-verify"] ?? data.insecure;
    if (pbk && security === "none") security = "reality";
  }

  if (options.mode === "sing-box" || options.mode === "mihomo") {
    const outbound: AnyObject = {
      [options.mode === "mihomo" ? "name" : "tag"]: tag,
      type: "vless",
      server,
      port,
      uuid,
      network,
      path,
      host: host || undefined,
      sni,
      security,
      fp: fp || undefined,
      publicKey: pbk || undefined,
      shortId: sid || undefined,
      insecure,
    };
    if (flow) outbound.flow = flow;
    if (security === "tls" || security === "reality") {
      outbound.tls = true;
      outbound.servername = sni;
    }
    if (options.mode === "mihomo") {
      if (network === "ws") {
        outbound["ws-opts"] = {
          path,
          headers: host ? { Host: host } : undefined,
        };
      } else if (network === "grpc") {
        outbound["grpc-opts"] = { "grpc-service-name": path };
      }
      if (pbk) {
        outbound["reality-opts"] = { "public-key": pbk, "short-id": sid };
        if (fp) outbound["client-fingerprint"] = fp;
      }
      if (insecure !== undefined) outbound["skip-cert-verify"] = insecure !== false;
    }
    return outbound;
  }

  const streamSettings: AnyObject = { network, security };
  if (security === "tls" || security === "reality") {
    streamSettings.tlsSettings = {
      serverName: sni,
      fingerprint: fp || "chrome",
      allowInsecure: insecure !== false,
    };
  }
  if (security === "reality") {
    streamSettings.realitySettings = {
      publicKey: pbk,
      shortId: sid,
      serverName: sni,
      fingerprint: fp || "chrome",
    };
  }
  Object.assign(streamSettings, getXrayTransport(network, path, host, path));
  return {
    protocol: "vless",
    tag,
    settings: {
      vnext: [
        {
          address: server,
          port,
          users: [{ id: uuid, encryption: "none", flow }],
        },
      ],
    },
    streamSettings,
  };
}

function buildHysteria2(data: AnyObject | URL, tag: string): AnyObject | null {
  let server: string, port: number | null, password: string, sni: string;
  let insecure: unknown = undefined;
  let up: unknown = undefined;
  let down: unknown = undefined;
  let obfs: string | undefined;
  let obfsPassword: string | undefined;
  let alpn: unknown = undefined;
  let ports: string | undefined;

  if (data instanceof URL) {
    server = data.hostname;
    port = validPort(data.port);
    password = safeDecode(data.username) || safeDecode(data.password);
    const params = data.searchParams;
    sni = params.get("sni") || server;
    if (params.get("insecure") === "1") insecure = true;
    up = params.get("up") || params.get("upmbps") || undefined;
    down = params.get("down") || params.get("downmbps") || undefined;
    obfs = params.get("obfs") || undefined;
    obfsPassword = params.get("obfs-password") || params.get("obfs_password") || undefined;
    const alpnParam = params.get("alpn");
    if (alpnParam) alpn = alpnParam.split(",");
    ports = params.get("mport") || params.get("ports") || undefined;
  } else {
    server = data.server;
    port = validPort(data.port || data.server_port);
    password = data.password || data.auth;
    sni = data.sni || data.servername || server;
    insecure = data["skip-cert-verify"] ?? data.insecure;
    up = data.up ?? data.up_mbps ?? data["up-mbps"];
    down = data.down ?? data.down_mbps ?? data["down-mbps"];
    if (typeof data.obfs === "object" && data.obfs) {
      obfs = data.obfs.type || data.obfs.obfs || "salamander";
      obfsPassword = data.obfs.password || data.obfs["obfs-password"];
    } else {
      obfs = data.obfs || undefined;
      obfsPassword =
        data["obfs-password"] || data.obfs_password || data.obfsPassword || undefined;
    }
    alpn = data.alpn;
    ports = data.ports || data.mport || undefined;
  }

  if (!server || !port || !password) return null;

  if (options.mode === "xray") {
    log.verbose(`Skipping hysteria2 for Xray (unsupported): ${server}:${port}`);
    return null;
  }

  if (options.mode === "sing-box" || options.mode === "mihomo") {
    const outbound: AnyObject = {
      [options.mode === "mihomo" ? "name" : "tag"]: tag,
      type: "hysteria2",
      server,
      port,
      password,
      sni,
      tls: true,
      insecure,
    };

    if (up != null && up !== "") {
      const n = Number(up);
      if (options.mode === "mihomo") outbound.up = Number.isFinite(n) ? n : up;
      else outbound.up_mbps = Number.isFinite(n) ? n : Number(up) || undefined;
    }
    if (down != null && down !== "") {
      const n = Number(down);
      if (options.mode === "mihomo") outbound.down = Number.isFinite(n) ? n : down;
      else outbound.down_mbps = Number.isFinite(n) ? n : Number(down) || undefined;
    }
    if (obfs) {
      if (options.mode === "mihomo") {
        outbound.obfs = obfs;
        if (obfsPassword) outbound["obfs-password"] = obfsPassword;
      } else {
        outbound.obfs = {
          type: obfs === "salamander" || obfs === "tls" ? obfs : "salamander",
          password: obfsPassword || "",
        };
      }
    }
    if (alpn != null) {
      outbound.alpn = Array.isArray(alpn)
        ? alpn
        : String(alpn)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    if (ports) outbound.ports = ports;

    if (options.mode === "mihomo") {
      outbound["skip-cert-verify"] = insecure !== false;
    }
    return outbound;
  }
  return null;
}

function buildTuic(data: AnyObject | URL, tag: string): AnyObject | null {
  let server: string,
    port: number | null,
    uuid: string,
    password: string,
    sni: string;
  let insecure: unknown = undefined;
  let congestion: string | undefined;
  let udpRelayMode: string | undefined;
  let alpn: unknown = undefined;
  let zeroRtt: unknown = undefined;
  let heartbeat: unknown = undefined;

  if (data instanceof URL) {
    server = data.hostname;
    port = validPort(data.port);
    uuid = safeDecode(data.username);
    const params = data.searchParams;
    password = params.get("password") || "";
    sni = params.get("sni") || server;
    if (params.get("insecure") === "1" || params.get("allow_insecure") === "1") {
      insecure = true;
    }
    congestion =
      params.get("congestion_control") ||
      params.get("congestion-controller") ||
      params.get("congestion") ||
      undefined;
    udpRelayMode =
      params.get("udp_relay_mode") || params.get("udp-relay-mode") || undefined;
    const alpnParam = params.get("alpn");
    if (alpnParam) alpn = alpnParam.split(",");
    if (params.get("reduce_rtt") === "1" || params.get("zero_rtt") === "1") {
      zeroRtt = true;
    }
  } else {
    server = data.server;
    port = validPort(data.port || data.server_port);
    uuid = data.uuid || data.id;
    password = data.password;
    sni = data.sni || data.servername || server;
    insecure = data["skip-cert-verify"] ?? data.insecure;
    congestion =
      data.congestion_control ||
      data["congestion-controller"] ||
      data.congestion ||
      undefined;
    udpRelayMode =
      data.udp_relay_mode || data["udp-relay-mode"] || data.udpRelayMode || undefined;
    alpn = data.alpn;
    zeroRtt =
      data.zero_rtt_handshake ??
      data["reduce-rtt"] ??
      data.reduce_rtt ??
      data.zeroRtt;
    heartbeat = data.heartbeat;
  }

  if (!server || !port || !uuid) return null;

  if (options.mode === "xray") {
    log.verbose(`Skipping tuic for Xray (unsupported): ${server}:${port}`);
    return null;
  }

  if (options.mode === "sing-box" || options.mode === "mihomo") {
    const outbound: AnyObject = {
      [options.mode === "mihomo" ? "name" : "tag"]: tag,
      type: "tuic",
      server,
      port,
      uuid,
      password,
      sni,
      tls: true,
      insecure,
    };

    if (congestion) {
      if (options.mode === "mihomo") {
        outbound["congestion-controller"] = congestion;
      } else {
        outbound.congestion_control = congestion;
      }
    }
    if (udpRelayMode) {
      if (options.mode === "mihomo") {
        outbound["udp-relay-mode"] = udpRelayMode;
      } else {
        outbound.udp_relay_mode = udpRelayMode;
      }
    }
    if (alpn != null) {
      outbound.alpn = Array.isArray(alpn)
        ? alpn
        : String(alpn)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    if (zeroRtt !== undefined) {
      if (options.mode === "mihomo") {
        outbound["reduce-rtt"] = Boolean(zeroRtt);
      } else {
        outbound.zero_rtt_handshake = Boolean(zeroRtt);
      }
    }
    if (heartbeat != null && options.mode === "sing-box") {
      outbound.heartbeat = heartbeat;
    }

    if (options.mode === "mihomo") {
      outbound["skip-cert-verify"] = insecure !== false;
    }
    return outbound;
  }
  return null;
}

function nodeSignature(parts: {
  protocol: string;
  server: unknown;
  port: unknown;
  id?: unknown;
  network?: unknown;
  path?: unknown;
  sni?: unknown;
}): string {
  return makeSignature([
    parts.protocol,
    parts.server,
    parts.port,
    parts.id,
    parts.network || "tcp",
    parts.path || "",
    parts.sni || "",
  ]);
}

// ============================================================
// Proxy Parsers
// ============================================================

function parseProxies(
  rawLinks: string[],
  mihomoObjects: AnyObject[],
): AnyObject[] {
  protocolCounters.clear();
  const seen = new Set<string>();
  const outbounds: AnyObject[] = [];

  for (const proxyObj of mihomoObjects) {
    try {
      const type = String(proxyObj.type || "").toLowerCase();
      let outbound: AnyObject | null = null;
      let signature = "";
      let tempTag = "";

      if (type === "vmess") {
        signature = nodeSignature({
          protocol: "vmess",
          server: proxyObj.server,
          port: proxyObj.port,
          id: proxyObj.uuid || proxyObj.id,
          network: proxyObj.network || proxyObj.net,
          path: proxyObj.path,
          sni: proxyObj.sni || proxyObj.servername,
        });
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("vmess");
        outbound = buildVmess(proxyObj, tempTag);
      } else if (type === "ss" || type === "shadowsocks") {
        signature = nodeSignature({
          protocol: "ss",
          server: proxyObj.server,
          port: proxyObj.port,
          id: `${proxyObj.cipher}|${proxyObj.password}`,
        });
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("ss");
        outbound = buildShadowsocks(proxyObj, tempTag);
      } else if (type === "trojan") {
        signature = nodeSignature({
          protocol: "trojan",
          server: proxyObj.server,
          port: proxyObj.port,
          id: proxyObj.password,
          network: proxyObj.network,
          path: proxyObj.path || proxyObj["ws-opts"]?.path,
          sni: proxyObj.sni || proxyObj.servername,
        });
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("trojan");
        outbound = buildTrojan(proxyObj, tempTag);
      } else if (type === "vless") {
        signature = nodeSignature({
          protocol: "vless",
          server: proxyObj.server,
          port: proxyObj.port,
          id: proxyObj.uuid || proxyObj.id,
          network: proxyObj.network,
          path: proxyObj.path,
          sni: proxyObj.sni || proxyObj.servername,
        });
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("vless");
        outbound = buildVless(proxyObj, tempTag);
      } else if (type === "hysteria2" || type === "hy2") {
        signature = nodeSignature({
          protocol: "hysteria2",
          server: proxyObj.server,
          port: proxyObj.port,
          id: proxyObj.password,
          sni: proxyObj.sni,
        });
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("hysteria2");
        outbound = buildHysteria2(proxyObj, tempTag);
      } else if (type === "tuic") {
        signature = nodeSignature({
          protocol: "tuic",
          server: proxyObj.server,
          port: proxyObj.port,
          id: proxyObj.uuid,
          sni: proxyObj.sni,
        });
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("tuic");
        outbound = buildTuic(proxyObj, tempTag);
      } else {
        log.verbose(`Unsupported YAML/JSON proxy type: ${type || "(empty)"}`);
      }

      if (outbound && signature) {
        seen.add(signature);
        outbounds.push(outbound);
      }
    } catch (err) {
      log.verbose(`Failed parsing YAML/JSON proxy: ${(err as Error).message}`);
    }
  }

  for (const originalLine of rawLinks) {
    if (originalLine.startsWith("#")) continue;
    let line = originalLine;
    if (!line.includes("://")) {
      const decoded = decodeBase64(line);
      if (!decoded) continue;
      line = decoded;
    }

    try {
      let signature = "";
      let outbound: AnyObject | null = null;
      let tempTag = "";

      if (line.startsWith("vmess://")) {
        const payload = decodeBase64(line.slice(8));
        if (!payload) continue;
        const data = JSON.parse(payload);
        signature = makeSignature(["vmess", data.add, data.port, data.id]);
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("vmess");
        outbound = buildVmess(data, tempTag);
      } else if (line.startsWith("ss://")) {
        const data = parseShadowsocks(line);
        if (!data) continue;
        signature = makeSignature([
          "ss",
          data.server,
          data.port,
          data.method,
          data.password,
        ]);
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("ss");
        outbound = buildShadowsocks(data, tempTag);
      } else if (line.startsWith("trojan://")) {
        const url = new URL(line);
        signature = makeSignature([
          "trojan",
          url.hostname,
          url.port,
          url.username,
        ]);
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("trojan");
        outbound = buildTrojan(url, tempTag);
      } else if (line.startsWith("vless://")) {
        const url = new URL(line);
        signature = makeSignature([
          "vless",
          url.hostname,
          url.port,
          url.username,
        ]);
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("vless");
        outbound = buildVless(url, tempTag);
      } else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) {
        const url = new URL(line);
        signature = makeSignature(["hysteria2", url.hostname, url.port]);
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("hysteria2");
        outbound = buildHysteria2(url, tempTag);
      } else if (line.startsWith("tuic://")) {
        const url = new URL(line);
        signature = makeSignature([
          "tuic",
          url.hostname,
          url.port,
          url.username,
        ]);
        if (seen.has(signature)) continue;
        tempTag = nextTempTag("tuic");
        outbound = buildTuic(url, tempTag);
      } else {
        continue;
      }

      if (!outbound || !signature) continue;
      seen.add(signature);
      outbounds.push(outbound);
    } catch (error) {
      log.verbose(`Failed parsing link: ${(error as Error).message}`);
    }
  }

  return outbounds;
}

// ============================================================
// Location Testing (Quiet / Concise)
// ============================================================

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForPort(
  port: number,
  proc: ReturnType<typeof Bun.spawn>,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderrText = await new Response(proc.stderr).text();
      throw new Error(
        `Exited with code ${proc.exitCode}: ${stderrText.trim().split("\n")[0]}`,
      );
    }
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.setTimeout(400);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await sleep(200);
  }
  throw new Error("Timed out waiting for proxy port");
}

async function detectExitCountry(outbound: AnyObject): Promise<string | null> {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "proxy-location-"));
  const configPath = join(
    tempDir,
    options.mode === "mihomo" ? "config.yaml" : "config.json",
  );
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    let spawnArgs: string[];

    if (options.mode === "mihomo") {
      const currentTagName = outbound.name || outbound.tag || "probe";
      const probeNode: AnyObject = {
        ...outbound,
        name: currentTagName,
      };
      delete probeNode.tag;
      const yamlTestConfig = objectToYaml({
        "mixed-port": port,
        "log-level": "error",
        proxies: [probeNode],
        "proxy-groups": [
          { name: "TestGroup", type: "select", proxies: [currentTagName] },
        ],
        rules: ["MATCH, TestGroup"],
      });
      await Bun.write(configPath, yamlTestConfig);
      spawnArgs = [binary, "-d", tempDir, "-f", configPath];
    } else if (options.mode === "sing-box") {
      const currentTagName = outbound.tag || outbound.name;
      const testOutbound = formatSingBoxOutbound({
        ...outbound,
        tag: currentTagName,
      });
      delete testOutbound.name;

      const config = {
        log: { level: "error" },
        inbounds: [
          {
            type: "mixed",
            tag: "location-in",
            listen: "127.0.0.1",
            listen_port: port,
          },
        ],
        outbounds: [testOutbound, { type: "direct", tag: "direct" }],
      };
      await Bun.write(configPath, JSON.stringify(config));
      spawnArgs = [binary, "run", "-c", configPath];
    } else {
      const currentTagName = outbound.tag || outbound.name;
      const config = {
        log: { loglevel: "error" },
        inbounds: [
          {
            tag: "location-in",
            port,
            listen: "127.0.0.1",
            protocol: "socks",
            settings: { auth: "noauth", udp: true },
          },
        ],
        outbounds: [
          { ...outbound, tag: currentTagName },
          { tag: "direct", protocol: "freedom" },
        ],
      };
      await Bun.write(configPath, JSON.stringify(config));
      spawnArgs = [binary, "run", "-c", configPath];
    }

    proc = Bun.spawn(spawnArgs, { stdout: "ignore", stderr: "pipe" });
    activeChildren.add(proc as unknown as ChildProcess);

    await waitForPort(port, proc, options.timeout);

    const proxyUrl =
      options.mode === "xray"
        ? `socks5h://127.0.0.1:${port}`
        : `http://127.0.0.1:${port}`;
    const result = await runCommand(
      "curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--connect-timeout",
        "3",
        "--max-time",
        "6",
        "-w",
        "\n__TIME_TOTAL__%{time_total}",
        "--proxy",
        proxyUrl,
        "https://cloudflare.com/cdn-cgi/trace",
      ],
      Math.min(LOCATION_TIMEOUT, options.timeout),
    );

    const timeMatch = result.stdout.match(/__TIME_TOTAL__([\d.]+)/);
    const latencyMs = timeMatch
      ? Math.round(parseFloat(timeMatch[1]) * 1000)
      : null;
    const body = result.stdout.replace(/\n__TIME_TOTAL__[\d.]+/, "");
    const country = body.match(/^loc=([A-Z]{2})$/m)?.[1];
    if (!country) {
      failedCount++;
      log.verbose(
        `[FAIL] ${outbound.tag || outbound.name || "?"}: no exit country`,
      );
      return null;
    }
    if (latencyMs !== null) {
      (outbound as AnyObject)._latencyMs = latencyMs;
    }
    return country;
  } catch (err) {
    failedCount++;
    log.verbose(
      `[FAIL] ${outbound.tag || outbound.name || "?"}: ${(err as Error).message}`,
    );
    return null;
  } finally {
    if (proc) {
      activeChildren.delete(proc as unknown as ChildProcess);
      if (proc.exitCode === null) {
        proc.kill(15);
        await sleep(1000);
        if (proc.exitCode === null) proc.kill(9);
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function locateProxies(proxies: AnyObject[]): Promise<AnyObject[]> {
  const countryCounters = new Map<string, number>();
  const total = proxies.length;
  const located: AnyObject[] = [];
  let nextIndex = 0;
  let stop = false;
  failedCount = 0;

  async function worker(): Promise<void> {
    while (!stop) {
      const index = nextIndex++;
      if (index >= total) return;
      if (options.limit !== null && located.length >= options.limit) {
        stop = true;
        return;
      }

      const outbound = proxies[index];
      const workTag = String(
        outbound.tag || outbound.name || `node${index + 1}`,
      );
      const progress = `[${index + 1}/${total}]`;

      try {
        const country = await detectExitCountry(outbound);
        if (stop) return;
        if (!country) continue;

        if (options.limit !== null && located.length >= options.limit) {
          stop = true;
          return;
        }

        const number = (countryCounters.get(country) || 0) + 1;
        countryCounters.set(country, number);

        const newTag = `${country.toLowerCase()}${number}`;
        applyFinalTag(outbound, newTag);
        outbound._country = country;

        const latency =
          outbound._latencyMs != null ? `  ${outbound._latencyMs}ms` : "";
        log.ok(
          `${progress} ${workTag}  ->  ${kleur.green}${newTag}${kleur.reset} (${country})${latency}`,
        );
        located.push(outbound);

        if (options.limit !== null && located.length >= options.limit) {
          stop = true;
          return;
        }
      } catch {
        failedCount++;
      }
    }
  }

  const workerCount = Math.min(options.concurrency, total);
  log.step(
    `test ${total} node(s)  workers=${workerCount}` +
      (options.limit != null ? `  stop-at=${options.limit}` : ""),
  );

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (options.limit !== null && located.length > options.limit) {
    located.length = options.limit;
  }

  log.ok(`alive ${located.length}/${total}`);
  if (failedCount > 0) {
    log.warn(`dead  ${failedCount}/${total}`);
  }

  return located;
}

// ============================================================
// Final Config Generators
// ============================================================

function generateMihomoConfig(proxies: AnyObject[]): AnyObject {
  const clean = proxies.map((p) => stripInternal(p));
  const tags = clean.map((p) => p.name);
  return {
    "mixed-port": listenPort,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    proxies: clean,
    "proxy-groups": [
      {
        name: "PROXY",
        type: "select",
        proxies: ["URLTest", ...tags, "DIRECT"],
      },
      {
        name: "URLTest",
        type: "url-test",
        proxies: tags,
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 50,
      },
    ],
    rules: ["MATCH, PROXY"],
  };
}

function stripInternal(obj: AnyObject): AnyObject {
  const out: AnyObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

function generateSingBoxConfig(proxies: AnyObject[]): AnyObject {
  const formattedProxies = proxies.map((p) => stripInternal(formatSingBoxOutbound(p)));
  const tags = formattedProxies.map((proxy) => proxy.tag);

  return {
    $schema: "https://sing-box.sagernet.org/schema.json",
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        { type: "local", tag: "direct-dns" },
        {
          type: "https",
          tag: "cloudflare-doh",
          detour: "Selector",
          server: "1.1.1.1",
          server_port: 443,
          path: "/dns-query",
          domain_resolver: "direct-dns",
        },
      ],
      final: "cloudflare-doh",
      strategy: "prefer_ipv4",
    },
    services: [
      {
        type: "api",
        listen: "127.0.0.1",
        listen_port: 3030,
        access_control_allow_origin: ["*"],
        access_control_allow_private_network: true,
      },
    ],
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: "127.0.0.1",
        listen_port: listenPort,
      },
    ],
    outbounds: [
      {
        type: "selector",
        tag: "Selector",
        outbounds: ["URLTest", ...tags, "direct"],
        default: "URLTest",
      },
      {
        type: "urltest",
        tag: "URLTest",
        outbounds: tags,
        url: "https://www.gstatic.com/generate_204",
        interval: "30m",
        tolerance: 50,
      },
      ...formattedProxies,
      { type: "direct", tag: "direct" },
    ],
    route: {
      default_domain_resolver: {
        server: "direct-dns",
        strategy: "prefer_ipv4",
      },
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
      ],
      final: "Selector",
    },
  };
}

function generateXrayConfig(proxies: AnyObject[]): AnyObject {
  const tags = proxies.map((proxy) => proxy.tag);

  return {
    log: { loglevel: "info" },
    dns: {
      servers: ["1.1.1.1", "8.8.8.8", { address: "localhost", port: 53 }],
    },
    inbounds: [
      {
        tag: "mixed-in",
        port: listenPort,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: { auth: "noauth", udp: true },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
      },
    ],
    outbounds: [
      ...proxies,
      { tag: "direct", protocol: "freedom" },
      { tag: "block", protocol: "blackhole" },
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      balancers: [
        { tag: "Selector", selector: tags, strategy: { type: "leastPing" } },
      ],
      rules: [
        { type: "field", inboundTag: ["mixed-in"], balancerTag: "Selector" },
        { type: "field", port: "53", outboundTag: "direct" },
      ],
    },
    observatory: {
      subjectSelector: tags,
      probeUrl: "https://www.gstatic.com/generate_204",
      probeInterval: "30m",
    },
  };
}

async function validateConfig(
  configPath: string,
  configDir: string,
): Promise<void> {
  let args: string[];
  if (options.mode === "mihomo") {
    args = ["-t", "-d", configDir, "-f", configPath];
  } else {
    args =
      options.mode === "xray"
        ? ["run", "-test", "-c", configPath]
        : ["check", "-c", configPath];
  }

  log.step(`validate with ${binary}`);
  try {
    const result = await runCommand(binary, args, 30_000);
    if (result.stdout.trim()) log.verbose(result.stdout.trim());
    if (result.stderr.trim()) log.verbose(result.stderr.trim());
    log.ok("validation passed");
  } catch (err) {
    throw new Error(
      `Config validation failed — output was not written.\n${(err as Error).message}`,
    );
  }
}

function yamlQuote(value: string): string {
  if (
    value === "" ||
    /[:#{}[\],&*?|>!%@`"'\\]/.test(value) ||
    /[\r\n]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(true|false|null|yes|no|on|off)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/i.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function objectToYaml(obj: AnyObject, indent = 0): string {
  let yaml = "";
  const spaces = " ".repeat(indent);
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith("_")) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        yaml += `${spaces}${key}: []\n`;
        continue;
      }
      yaml += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          const sub = objectToYaml(item as AnyObject, indent + 2).replace(
            /^( +)/,
            (_, s) => " ".repeat(s.length),
          );
          const subLines = sub.split("\n").filter((l) => l.length > 0);
          if (subLines.length === 0) {
            yaml += `${spaces}- {}\n`;
          } else {
            yaml += `${spaces}- ${subLines[0].trimStart()}\n`;
            for (let i = 1; i < subLines.length; i++) {
              yaml += `${subLines[i]}\n`;
            }
          }
        } else if (typeof item === "string") {
          yaml += `${spaces}- ${yamlQuote(item)}\n`;
        } else {
          yaml += `${spaces}- ${item}\n`;
        }
      }
    } else if (typeof value === "object") {
      yaml += `${spaces}${key}:\n${objectToYaml(value as AnyObject, indent + 2)}`;
    } else if (typeof value === "string") {
      yaml += `${spaces}${key}: ${yamlQuote(value)}\n`;
    } else if (typeof value === "boolean" || typeof value === "number") {
      yaml += `${spaces}${key}: ${value}\n`;
    } else {
      yaml += `${spaces}${key}: ${yamlQuote(String(value))}\n`;
    }
  }
  return yaml;
}

async function writeConfig(config: AnyObject): Promise<void> {
  const targetOutput =
    options.mode === "mihomo" &&
    !options.output.endsWith(".yaml") &&
    !options.output.endsWith(".yml")
      ? options.output.replace(/\.json$/, ".yaml")
      : options.output;
  const outputPath = resolve(targetOutput);
  const outputDir = dirname(outputPath);

  if (!existsSync(outputDir)) {
    throw new Error(`Output directory does not exist: ${outputDir}`);
  }

  const tempDir = mkdtempSync(join(outputDir, ".proxy-config-"));
  const tempPath = join(
    tempDir,
    options.mode === "mihomo" ? "config.yaml" : "config.json",
  );

  try {
    const fileContent =
      options.mode === "mihomo"
        ? objectToYaml(config)
        : JSON.stringify(config, null, 2) + "\n";
    await Bun.write(tempPath, fileContent);
    await validateConfig(tempPath, tempDir);
    renameSync(tempPath, outputPath);
    log.ok(`saved ${outputPath}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ============================================================
// Main Execution
// ============================================================

async function main(): Promise<void> {
  const { rawLinks, mihomoObjects } = await loadInputs();

  log.step("parse");
  let proxies = parseProxies(rawLinks, mihomoObjects);
  log.ok(`unique ${kleur.bold}${proxies.length}${kleur.reset}`);

  if (proxies.length === 0) {
    throw new Error("No supported proxy links or YAML/JSON proxies were found.");
  }

  // Filter before test: Protocol filter (supporting 'ss' and 'shadowsocks' interchangeably)
  if (options.protocols.length > 0) {
    const before = proxies.length;
    proxies = proxies.filter((p) => {
      const t = String(p.type || "").toLowerCase();
      const normalized = t === "ss" ? "shadowsocks" : t === "hy2" ? "hysteria2" : t;
      return (
        options.protocols.includes(t) ||
        options.protocols.includes(normalized) ||
        (options.protocols.includes("ss") && normalized === "shadowsocks") ||
        (options.protocols.includes("shadowsocks") && normalized === "ss")
      );
    });
    log.info(`Filtered by protocol [${options.protocols.join(", ")}]: kept ${proxies.length}/${before} nodes`);
  }

  if (proxies.length === 0) {
    throw new Error("All proxies were filtered out by --protocol filters.");
  }

  // Run location tests on surviving nodes to discover real exit countries
  let located = await locateProxies(proxies);

  if (located.length === 0) {
    throw new Error("No working proxies were located. No config was written.");
  }

  // Filter AFTER test: Exact match against tested geo-ip country (`_country`)
  if (options.exitCountries.length > 0) {
    const before = located.length;
    located = located.filter((n) => {
      const cc = String(n._country || "").toLowerCase();
      return options.exitCountries.includes(cc);
    });
    log.info(`Filtered by tested exit country [${options.exitCountries.join(", ")}]: kept ${located.length}/${before} working nodes`);
  }

  if (located.length === 0) {
    throw new Error("No working proxies matched the requested --exit countries after testing.");
  }

  for (let i = 0; i < located.length; i++) {
    const n = located[i];
    const current = String(n.tag || n.name || "");
    if (/^(proxy|vmess|vless|ss|trojan|hysteria2|hy2|tuic)\d+$/i.test(current)) {
      const cc = String(n._country || "xx").toLowerCase();
      applyFinalTag(n, `${cc}${i + 1}`);
      log.verbose(`retagged leftover ${current} -> ${n.tag || n.name}`);
    }
  }

  log.step("write config");
  const config =
    options.mode === "sing-box"
      ? generateSingBoxConfig(located)
      : options.mode === "mihomo"
        ? generateMihomoConfig(located)
        : generateXrayConfig(located);

  await writeConfig(config);

  console.log("");
  log.ok(
    `done  nodes=${located.length}  file=${kleur.bold}${resolve(options.output)}${kleur.reset}`,
  );

  if (options.exec) {
    const outputAbsPath = resolve(options.output);
    const outputDir = dirname(outputAbsPath);
    let execArgs: string[];

    if (options.mode === "mihomo") {
      execArgs = [binary, "-d", outputDir, "-f", outputAbsPath];
    } else if (options.mode === "sing-box") {
      execArgs = [binary, "run", "-c", outputAbsPath];
    } else {
      execArgs = [binary, "run", "-c", outputAbsPath];
    }

    log.step(`exec ${binary}`);
    const proc = Bun.spawn(execArgs, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    activeChildren.add(proc as unknown as ChildProcess);
    await proc.exited;
  } else {
    const runCommandExample =
      options.mode === "mihomo"
        ? `${binary} -d . -f ${options.output}`
        : `${binary} run -c ${options.output}`;
    log.info(`run  ${kleur.green}${runCommandExample}${kleur.reset}`);
  }
}

main().catch((error) => {
  console.error("");
  log.error(`${(error as Error).message}`);
  process.exit(1);
});