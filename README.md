# TENET

TENET is a CLI tool that reads proxy subscriptions or configuration files, tests proxy nodes, detects their exit countries, sorts working nodes by latency, and generates a client configuration.

## Requirements

- [Bun](https://bun.sh/)
- A compatible core:
  - sing-box (`sing-box` or `sbx`)
  - Xray (`xray`)
  - Mihomo (`mihomo`, `clash-meta`, or `clash`)

You can provide a custom core executable with `--bin`.

## Usage

```bash
bun run bin.ts [options] <input1> [input2 ...]
```

If no input is supplied, TENET looks for `sub.txt` in the current directory.

## Examples

```bash
# Generate a sing-box config
bun run bin.ts -s -v sub.txt

# Generate an Xray config
bun run bin.ts -x sub.txt -o xray.json

# Generate a Mihomo config
bun run bin.ts -m sub.txt -o mihomo.yaml

# Filter protocols and exit countries
bun run bin.ts -s --protocol vless,ss --exit us,de sub.txt

# Use a custom sing-box binary and run the generated config
bun run bin.ts -s --bin ./bin/sing-box --exec sub.txt
```

## Options

| Option                         | Description                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| `-s`, `--sing-box`             | Generate a sing-box config (default mode)                          |
| `-x`, `--xray`                 | Generate an Xray config                                            |
| `-m`, `--mihomo`               | Generate a Mihomo YAML config                                      |
| `-p`, `--protocol <list>`      | Filter protocols, comma-separated (for example: `vless,ss`)        |
| `-E`, `--exit <list>`          | Keep nodes matching detected exit countries (for example: `us,de`) |
| `-n`, `--limit <number>`       | Stop after the requested number of working nodes                   |
| `-c`, `--concurrency <number>` | Number of parallel proxy tests (default: `12`)                     |
| `-o`, `--output <file>`        | Output filename                                                    |
| `--bin <path>`                 | Use a custom core executable; accepts a path or command name       |
| `-t`, `--timeout <ms>`         | Per-node location-test timeout                                     |
| `-e`, `--exec`                 | Execute the selected core with the generated config                |
| `-v`, `--verbose`              | Show detailed activity logs                                        |
| `-h`, `--help`                 | Show help                                                          |

## Supported inputs

- Local files and remote URLs
- Clash/Mihomo YAML
- JSON containing Clash proxies, sing-box outbounds, or Xray outbounds
- Plain or Base64-encoded subscription content
- Proxy share links such as VMess, VLESS, Shadowsocks, Trojan, Hysteria2, and TUIC

## Output and sorting

TENET tests nodes concurrently, filters by detected exit country when requested, then sorts the final working nodes by measured latency (fastest first). Nodes without a latency measurement are placed last.

Default output filenames:

- sing-box: `xyz.json`
- Xray: `xry.json`
- Mihomo: `mihomo.yaml`

Mihomo output is always YAML.
