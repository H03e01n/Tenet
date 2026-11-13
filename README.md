# TENET (`bin.ts`)

A high-performance CLI utility written in TypeScript for **Bun** that loads, parses, tests, filters, and generates routing configurations for **sing-box**, **Xray**, and **Mihomo (Clash Meta)**.

## Features

* **Multi-Source Inputs**: Load subscription links, local YAML/JSON files, or remote URLs.

* **Robust Parsing**: Supports YAML (Clash), JSON (sing-box outbounds, Xray outbounds, Clash proxies), and base64 share links (`vmess`, `vless`, `trojan`, `ss`/`shadowsocks`, `hysteria2`, `tuic`).

* **Advanced Protocol & TLS Support**: Full parameter parsing for Hysteria2 (obfuscation, bandwidth limits, port hopping) and TUIC (congestion control, zero-RTT, UDP relay modes).

* **Concurrency & Location Testing**: Tests nodes in parallel against Cloudflare to verify latency and determine real-world GeoIP exit countries.

* **Smart Filtering**:

  * `--protocol` (pre-test filter for protocols like `vless`, `trojan`, `ss`/`shadowsocks`, etc.)

  * `--exit` (post-test filter ensuring only nodes exiting from specific countries like `us`, `de`, `nl` are kept)

* **Automatic Validation & Execution**: Validates generated configurations directly against core binaries and optionally starts them immediately.

## Prerequisites

* [Bun](https://bun.sh/) runtime installed.

* At least one core binary installed and available in your PATH:

  * `sing-box` (or `sbx`)

  * `xray`

  * `mihomo` (or `clash-meta`)

## Usage

```
bun run bin.ts [options] <input1> [input2 ...]

```

### Options

| Flag | Description | Default | 
| ----- | ----- | ----- | 
| `-s, --sing-box` | Generate sing-box configuration | **Yes** (Port: `2080`) | 
| `-x, --xray` | Generate Xray configuration | Port: `10808` | 
| `-m, --mihomo` | Use Mihomo core & generate YAML config | Port: `7890` | 
| `-p, --protocol <list>` | Filter by protocols (e.g. `vless,ss,trojan`) | All | 
| `-E, --exit <list>` | Filter by tested exit countries (e.g. `us,de`) | All | 
| `-n, --limit <number>` | Stop testing early once $N$ working nodes are found | Unlimited | 
| `-c, --concurrency <n>` | Number of parallel location tests | `12` | 
| `-t, --timeout <ms>` | Per-node connection timeout | `15000` | 
| `-o, --output <file>` | Custom output filename (`xyz.json`, `mihomo.yaml`, etc.) | Auto based on mode | 
| `-e, --exec` | Immediately execute the core binary with the generated config | `false` | 
| `-v, --verbose` | Show concise activity and debug logs | `false` | 
| `-h, --help` | Show help screen | — | 

## Examples

1. **Test a subscription URL and generate a sing-box config:**

   ```
   bun run bin.ts -s https://example.com/subscription/link
   
   ```

2. **Filter only `vless` and `shadowsocks` nodes, test for US/DE exit countries, and limit to 10 nodes:**

   ```
   bun run bin.ts -s --protocol vless,ss --exit us,de --limit 10 sub.yaml
   
   ```

3. **Generate a Mihomo YAML configuration and run it immediately:**

   ```
   bun run bin.ts -m -v -e config.json
   
   ```