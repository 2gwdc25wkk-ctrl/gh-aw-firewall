# Agentic Workflow Firewall

> [!WARNING]
> Releases v0.25.21 through v0.25.39 were retired due to a bug that impacted billing. If you are running one of these versions, please upgrade to the latest release as soon as possible.

A network firewall for agentic workflows that restricts outbound HTTP/HTTPS to an allowlist of domains.

> [!TIP]
> This project is a part of GitHub's explorations of [Agentic Workflows](https://github.com/github/gh-aw). For more background, check out the [project page](https://github.github.io/gh-aw/)! ✨

## How it works

`awf` runs your command inside a Docker sandbox with three containers:

- **Squid proxy** — filters outbound traffic by domain allowlist
- **Agent** — runs your command; all HTTP/HTTPS is routed through Squid
- **API proxy sidecar** *(optional)* — holds LLM API keys so they never reach the agent process

## Requirements

- **Docker**: 20.10+ with Docker Compose v2
- **Node.js**: 20.19.0+ (for building from source)
- **OS**: Ubuntu 22.04+ or compatible Linux distribution (x86_64 and arm64)

See [Compatibility](docs/compatibility.md) for full details on supported versions and tested configurations.

## Get started fast

```bash
curl -sSL https://raw.githubusercontent.com/github/gh-aw-firewall/main/install.sh | sudo bash
sudo awf --allow-domains github.com -- curl https://api.github.com
```

The `--` separator divides firewall options from the command to run.

To inspect the API proxy endpoints and models without running an agent command,
use `awf --reflect`. It prints the `/reflect` JSON response to stdout.

## Feature highlights

- **Declarative config support**: `--config <path>` with JSON/YAML + published JSON Schema
- **Domain and URL controls**: allow/deny domain rules, SSL Bump (`--ssl-bump`), and URL patterns (`--allow-urls`, requires `--ssl-bump`)
- **Data protection controls**: DLP scanning (`--enable-dlp`), DNS-over-HTTPS, and agent runtime limits (`--agent-timeout`)
- **API proxy capabilities**: OpenAI, Anthropic, Copilot, and Gemini targets with rate limits, token steering, and Anthropic auto-cache
- **Infrastructure flexibility**: upstream proxy chaining, host service access, Docker-in-Docker, custom mounts, memory limits, and TTY mode
- **Operational tooling**: pre-download images and inspect logs/stats/summaries/audits from live or saved runs

## CLI subcommands

- `awf predownload` — pre-pull runtime images for faster startup or offline environments
- `awf logs` — inspect firewall logs in raw/pretty/json
  - `awf logs stats` — aggregate traffic statistics
  - `awf logs summary` — markdown/json summaries (great for GitHub Actions step summaries)
  - `awf logs audit` — audit view with policy-rule matching (requires `policy-manifest.json`, typically from `--audit-dir`)

For the complete CLI surface area, run `awf --help`.

## GitHub Action quick start

```yaml
steps:
  - uses: actions/checkout@v4
  - name: Setup AWF
    uses: github/gh-aw-firewall@v1
  - name: Run command through firewall
    run: sudo awf --allow-domains github.com,api.github.com -- curl https://api.github.com
```

See [GitHub Actions](docs/github_actions.md) for advanced setup and `awf logs summary` examples.

## Explore the 
