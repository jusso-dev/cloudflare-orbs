# check=skip=FromPlatformFlagConstDisallowed
# Orb workspace image: the "computer" an orb's agent works on.
#
# - Linux/amd64 only (the sandbox-shim helper is a static amd64 binary).
# - Contains no credentials. Model and GitHub access are added by the Worker
#   when the container's outbound requests pass through it.
# - Keep it lean: image size is cold-start time.
# The platform is pinned on purpose: sandbox-shim is an amd64 binary, and an arm64 build host
# (Apple silicon) would otherwise produce an image it cannot run in.
FROM --platform=linux/amd64 node:24-trixie-slim

# Pinned: CLI flags and event formats change between releases, and the parsers
# in packages/harness are written against these.
ARG CLAUDE_CODE_VERSION=2.1.308
ARG CODEX_VERSION=0.156.1
# Must match the @cloudflare/sandbox version in apps/orbs/package.json.
ARG SANDBOX_SHIM_VERSION=1.0.3

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash build-essential ca-certificates curl git jq less make pkg-config procps \
		python3 python3-pip python3-venv ripgrep tmux unzip zip \
	&& rm -rf /var/lib/apt/lists/*

# Claude Code ships its native binary through its install script; Codex ships
# native binaries as dependencies, so it installs without running scripts.
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
	&& npm install --global --ignore-scripts @openai/codex@${CODEX_VERSION} \
	&& corepack enable \
	&& npm cache clean --force

COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

COPY orb-run /usr/local/bin/orb-run
COPY approve-mcp.mjs mcp.json demo-agent.mjs /opt/orb/
COPY tmux.conf /etc/tmux.conf

RUN chmod +x /usr/local/bin/orb-run \
	&& git config --system user.name "Orbs" \
	&& git config --system user.email "orbs@users.noreply.github.com" \
	&& git config --system --add safe.directory '*' \
	&& git config --system core.pager cat \
	&& mkdir -p /workspace /root/.orb

ENV HOME=/root \
	LANG=C.UTF-8 \
	PIP_BREAK_SYSTEM_PACKAGES=1 \
	GIT_TERMINAL_PROMPT=0 \
	CI=true

WORKDIR /workspace

# Start idle. The Durable Object runs everything else with exec().
CMD ["sleep", "infinity"]
