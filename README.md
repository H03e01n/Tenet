# TENET

TENET is a Bun CLI that reads proxy subscriptions or configuration files, tests each node, detects its exit country, sorts the working nodes by latency, and writes either a client config or a base64 share-link subscription.

## Requirements

- [Bun](https://bun.sh/)
- A compatible core, used to probe nodes:
  - sing-box (`sing-box` or `sbx`)
  - Xray (`xray`)
  - Mihomo (`mihomo`, `clash-meta`, or `clash`)

You can provide a custom core executable with `--bin`.

Xray cannot probe Hysteria2 or TUIC. Use sing-box or Mihomo when those protocols need to be tested or exported.

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

# Base64 subscription of working vless/ss nodes (share links, fastest first)
bun run bin.ts -b -s -v --protocol vless,ss -o base64.txt sub.txt

# Use a custom sing-box binary and run the generated config
bun run bin.ts -s --bin ./bin/sing-box --exec sub.txt
```

## Options

| Option | Description |
| --- | --- |
| `-s`, `--sing-box` | Generate a sing-box config (default mode, port `2080`) |
| `-x`, `--xray` | Generate an Xray config (port `10808`) |
| `-m`, `--mihomo` | Generate a Mihomo YAML config (port `7890`) |
| `-b`, `--base64` | Write a base64 subscription of share links instead of a core config |
| `-p`, `--protocol <list>` | Filter protocols before testing, comma-separated (`vless,ss,hy2`) |
| `-E`, `--exit <list>` | Keep nodes whose tested exit country matches (`us,de`) |
| `-n`, `--limit <number>` | Stop after this many working nodes |
| `-c`, `--concurrency <number>` | Parallel probe workers (default `12`) |
| `-o`, `--output <file>` | Output filename |
| `--bin <path>` | Core executable path or command name |
| `-t`, `--timeout <ms>` | Per-node probe timeout |
| `-e`, `--exec` | Run the selected core with the generated config (`--base64` ignores this) |
| `-v`, `--verbose` | Per-node probe logs and the final latency order |
| `-h`, `--help` | Show help |

`ss` and `shadowsocks` are the same filter. `hy2` and `hysteria2` are the same filter.

## Base64 subscription output

`-b` / `--base64` still probes nodes with the selected core, then writes one base64 blob instead of a client config. Decoding it yields newline-separated share links, fastest first:

- `vless://`
- `vmess://`
- `ss://`
- `trojan://`
- `hysteria2://`
- `tuic://`

The link remark is the final country tag (`us1`, `de2`, …), numbered in latency order. Default output file is `base64.txt` so a local `sub.txt` input is not overwritten.

```bash
base64 -d base64.txt
```

Sing-box or Mihomo is the right probe core for this mode. Hysteria2 and TUIC links are only emitted when that core can test them.

## Logging

Normal output is one line per stage plus one line per working node:

- protocol, temporary name, country tag, exit country, latency, and `server:port`
- latency is green under 200ms, yellow under 500ms, otherwise red
- failures stay quiet, with a progress beat and the top failure reasons at the end of the probe
- the run ends with protocol counts, country counts, and elapsed time

`-v` adds source fetches, each probe, skipped share links, and the final order.

## Supported inputs

- Local files and remote URLs
- Clash/Mihomo YAML
- JSON containing Clash proxies, sing-box outbounds, or Xray outbounds
- Plain or Base64-encoded subscription content
- Proxy share links: VMess, VLESS, Shadowsocks, Trojan, Hysteria2, and TUIC

## Output and sorting

TENET tests nodes concurrently, drops nodes that fail the optional exit-country filter, then sorts working nodes by measured latency (fastest first). Nodes without a latency measurement are placed last. Country tags are reassigned after that sort, so `us1` is the fastest US exit.

Default output filenames:

- sing-box: `xyz.json`
- Xray: `xry.json`
- Mihomo: `mihomo.yaml`
- base64 subscription: `base64.txt`

Mihomo output is always YAML. `--base64` does not rewrite the output extension.
