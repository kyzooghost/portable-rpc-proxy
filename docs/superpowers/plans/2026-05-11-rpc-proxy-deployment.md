# RPC Proxy Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal RPC proxy package with nginx Docker for VM deployment, Cloudflare Worker Free for no-Docker Cloudflare deployment, and Cloudflare Containers Paid as the Docker-on-Cloudflare path.

**Architecture:** Keep `RPC_UPSTREAM_URL` as the single upstream input. nginx validates values that are rendered into config before `envsubst`, derives scheme, upstream authority, TLS hostname, and path/query at container startup so SNI and `Host` are correct, rejects client query strings before forwarding, and clears accidental client secret headers. Cloudflare Worker Free forwards directly with `fetch()`, while Cloudflare Containers validates the same secret path token before forwarding to the nginx container.

**Tech Stack:** Docker, `nginx:1.27.5-alpine`, POSIX shell, Node.js built-in test runner, Cloudflare Workers, Wrangler `4.90.0`, `@cloudflare/containers` `0.3.3`.

---

## Workspace Note

The current directory is not a git repository. If this project should have commits, Task 1 initializes git so the commit steps work. If this plan is executed inside a different repository, skip the `git init` command and use the existing repository.

## File Structure

- Create `.gitignore`: ignore local secrets, generated files, dependency folders, and logs.
- Create `.dockerignore`: keep local secrets, dependencies, generated files, and git metadata out of Docker build context.
- Create `.env.example`: document placeholder-only runtime variables.
- Create `package.json`: pin Wrangler and Cloudflare Containers versions and provide test/deploy scripts.
- Create `docker/derive-upstream.sh`: reject nginx config metacharacters and raw `$`, then derive nginx scheme, upstream authority, TLS hostname, and path/query from `RPC_UPSTREAM_URL`.
- Create `docker/docker-entrypoint.sh`: validate `RPC_PROXY_LISTEN_PORT`, render nginx config with all derived upstream variables, then start nginx.
- Create `docker/nginx.conf.template`: nginx reverse proxy template with root-only routing, client query string rejection, redacted runtime error logging, SNI hostname, upstream `Host`, and cleared client secret headers.
- Create `Dockerfile`: build the nginx proxy image from a pinned nginx base image.
- Create `docker-compose.example.yml`: local and VM deployment example.
- Create `scripts/test-derive-upstream.sh`: shell test for URL derivation, invalid URL failures, unsafe nginx config characters including raw `$`, and TLS host separation.
- Create `scripts/test-entrypoint.sh`: shell test for listen port validation and rendered nginx config hardening.
- Create `scripts/test-nginx-routing.sh`: runtime Docker test proving root requests preserve configured upstream query strings, Cloudflare Containers health-probe hosts return 204 without forwarding, client query strings return 404 without forwarding, and non-root paths return 404.
- Create `cloudflare/worker.mjs`: Cloudflare Worker Free proxy.
- Create `cloudflare/worker.test.mjs`: Node built-in tests for the Worker proxy.
- Create `cloudflare/container-worker.mjs`: Cloudflare Containers Paid Worker entrypoint.
- Create `cloudflare/container-worker.test.mjs`: Node built-in tests for the Containers Worker proxy with mocked container lookup.
- Create `wrangler.free.example.toml`: Worker Free deployment config template.
- Create `wrangler.containers.example.toml`: Cloudflare Containers deployment config template.
- Create `README.md`: deployment and verification runbook.

### Task 1: Project Baseline

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `package.json`

- [ ] **Step 1: Initialize git if needed**

Run:

```bash
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init
```

Expected: command exits `0`. In the current workspace, it initializes a new git repository.

- [ ] **Step 2: Create `.gitignore`**

Write `.gitignore`:

```gitignore
.env
.env.*
!.env.example
.dev.vars*
node_modules/
npm-debug.log*
logs/
coverage/
dist/
.wrangler/
docker/generated/
*.log
```

- [ ] **Step 3: Create `.env.example`**

Write `.env.example`:

```dotenv
RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
RPC_PROXY_LISTEN_PORT=8545
RPC_PROXY_PUBLISHED_PORT=8545
RPC_PROXY_PATH_TOKEN=<long-random-route-token>
ETH_RPC_URL=http://127.0.0.1:8545
```

- [ ] **Step 4: Create `package.json`**

Write `package.json`:

```json
{
  "name": "rpc-proxy",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test cloudflare/*.test.mjs",
    "deploy:worker:free": "wrangler deploy --config wrangler.free.example.toml",
    "deploy:containers": "wrangler deploy --config wrangler.containers.example.toml",
    "dry-run:worker:free": "wrangler deploy --dry-run --config wrangler.free.example.toml",
    "dry-run:containers": "wrangler deploy --dry-run --config wrangler.containers.example.toml"
  },
  "dependencies": {
    "@cloudflare/containers": "0.3.3"
  },
  "devDependencies": {
    "wrangler": "4.90.0"
  }
}
```

- [ ] **Step 5: Install pinned npm dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and contains exact resolved versions for `wrangler` and `@cloudflare/containers`.

- [ ] **Step 6: Commit baseline files**

Run:

```bash
git add .gitignore .env.example package.json package-lock.json docs/superpowers/specs/2026-05-11-rpc-proxy-deployment-design.md docs/superpowers/plans/2026-05-11-rpc-proxy-deployment.md
git commit -m "docs: define rpc proxy deployment plan"
```

Expected: commit succeeds. If the plan file is still being edited during execution, commit it at the end of the task instead.

### Task 2: nginx Docker Proxy

**Files:**
- Create: `.dockerignore`
- Create: `scripts/test-derive-upstream.sh`
- Create: `scripts/test-entrypoint.sh`
- Create: `scripts/test-nginx-routing.sh`
- Create: `docker/derive-upstream.sh`
- Create: `docker/docker-entrypoint.sh`
- Create: `docker/nginx.conf.template`
- Create: `Dockerfile`
- Create: `docker-compose.example.yml`

Supported nginx upstream hosts are DNS hostnames with an optional `:port`, such as `rpc-provider.invalid` or `rpc-provider.invalid:443`. Optional ports must be decimal numbers from 1 through 65535. IPv6 literals and any authority shapes with extra colons are out of scope and fail before nginx config rendering. Literal `$` characters in upstream URLs must be percent-encoded as `%24`; raw `$` is rejected because nginx treats it as a variable marker in `proxy_pass`. JSON-RPC clients POST to `/` with a request body; nginx rejects any client query string with 404 so client args cannot corrupt a configured upstream query URL.

- [ ] **Step 1: Write the failing shell tests**

Write `scripts/test-derive-upstream.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

assert_equals() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL %s\nexpected: %s\nactual:   %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

derive() {
  RPC_UPSTREAM_URL="$1" sh -c '. ./docker/derive-upstream.sh; printf "%s|%s|%s|%s\n" "$RPC_UPSTREAM_SCHEME" "$RPC_UPSTREAM_HOST" "${RPC_UPSTREAM_TLS_HOST-}" "$RPC_UPSTREAM_PATH"'
}

assert_failure() {
  local url="$1"
  local expected_message="$2"
  local label="$3"
  local stdout_file
  local stderr_file

  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  if RPC_UPSTREAM_URL="$url" sh -c '. ./docker/derive-upstream.sh' >"$stdout_file" 2>"$stderr_file"; then
    printf 'FAIL %s unexpectedly passed\n' "$label" >&2
    rm -f "$stdout_file" "$stderr_file"
    exit 1
  fi

  if ! grep -F -q -- "$expected_message" "$stderr_file"; then
    printf 'FAIL %s error was not actionable\n' "$label" >&2
    cat "$stderr_file" >&2
    rm -f "$stdout_file" "$stderr_file"
    exit 1
  fi

  rm -f "$stdout_file" "$stderr_file"
}

UNSAFE_NGINX_CONFIG_MESSAGE='RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration'
INVALID_UPSTREAM_AUTHORITY_MESSAGE='RPC_UPSTREAM_URL must use a DNS hostname with optional port'
INVALID_UPSTREAM_PORT_MESSAGE='RPC_UPSTREAM_URL port must be a number from 1 to 65535'

assert_equals "https|rpc-provider.invalid|rpc-provider.invalid|/v2/key" "$(derive "https://rpc-provider.invalid/v2/key")" "https URL with path"
assert_equals "http|rpc-provider.invalid|rpc-provider.invalid|/" "$(derive "http://rpc-provider.invalid")" "http URL without path"
assert_equals "https|rpc-provider.invalid|rpc-provider.invalid|/v2/key?chain=mainnet" "$(derive "https://rpc-provider.invalid/v2/key?chain=mainnet")" "https URL with path and query"
assert_equals "https|rpc-provider.invalid|rpc-provider.invalid|/?api_key=key" "$(derive "https://rpc-provider.invalid?api_key=key")" "https root URL with query"
assert_equals "https|rpc-provider.invalid:443|rpc-provider.invalid|/v2/key" "$(derive "https://rpc-provider.invalid:443/v2/key")" "https URL with port"

assert_failure "ftp://rpc-provider.invalid/path" "RPC_UPSTREAM_URL must start with http:// or https://" "invalid scheme"
assert_failure "https:///v2/key" "RPC_UPSTREAM_URL must include a host" "empty host"
assert_failure "https://user:pass@rpc-provider.invalid/v2/key" "RPC_UPSTREAM_URL must not include userinfo" "userinfo"
assert_failure "https://rpc-provider.invalid/v2/key#frag" "RPC_UPSTREAM_URL must not include a fragment" "fragment"
assert_failure "https://rpc-provider.invalid:/v2/key" "$INVALID_UPSTREAM_PORT_MESSAGE" "empty upstream port"
assert_failure "https://rpc-provider.invalid:abc/v2/key" "$INVALID_UPSTREAM_PORT_MESSAGE" "non-numeric upstream port"
assert_failure "https://rpc-provider.invalid:0/v2/key" "$INVALID_UPSTREAM_PORT_MESSAGE" "zero upstream port"
assert_failure "https://rpc-provider.invalid:65536/v2/key" "$INVALID_UPSTREAM_PORT_MESSAGE" "above-range upstream port"
assert_failure "https://rpc-provider.invalid:99999/v2/key" "$INVALID_UPSTREAM_PORT_MESSAGE" "invalid nginx upstream port"
assert_failure "https://[2001:db8::1]/v2/key" "$INVALID_UPSTREAM_AUTHORITY_MESSAGE" "ipv6 upstream literal"
assert_failure "https://rpc-provider.invalid/v2/key;error_log /dev/stdout info" "$UNSAFE_NGINX_CONFIG_MESSAGE" "nginx directive injection characters"
assert_failure "https://rpc-provider.invalid/v2/key bad" "$UNSAFE_NGINX_CONFIG_MESSAGE" "nginx whitespace injection character"
assert_failure "https://rpc-provider.invalid/v2/{key}" "$UNSAFE_NGINX_CONFIG_MESSAGE" "nginx brace injection characters"
assert_failure 'https://rpc-provider.invalid/v2/key?auth=$http_authorization' "$UNSAFE_NGINX_CONFIG_MESSAGE" "nginx authorization variable"
assert_failure 'https://rpc-provider.invalid/v2/key?redirect=$request_uri' "$UNSAFE_NGINX_CONFIG_MESSAGE" "nginx request URI variable"
assert_failure 'https://rpc-provider.invalid/v2/key?value=$unknown_variable' "$UNSAFE_NGINX_CONFIG_MESSAGE" "nginx unknown variable"

printf 'PASS derive-upstream\n'
```

Write `scripts/test-entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SAFE_RPC_UPSTREAM_URL="https://rpc-provider.invalid/v2/key"
PORT_ERROR_MESSAGE="RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535"

assert_file_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if ! grep -F -q -- "$expected" "$file"; then
    printf 'FAIL %s\nexpected to find: %s\n' "$label" "$expected" >&2
    printf 'rendered config:\n' >&2
    cat "$file" >&2
    exit 1
  fi
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fake_bin="$tmp_dir/bin"
rendered_config="$tmp_dir/etc/nginx/nginx.conf"
entrypoint="$tmp_dir/rpc-proxy-entrypoint.sh"

mkdir -p "$fake_bin" "$tmp_dir/usr/local/bin" "$tmp_dir/etc/nginx/templates" "$tmp_dir/etc/nginx"
cp docker/derive-upstream.sh "$tmp_dir/usr/local/bin/derive-upstream.sh"
cp docker/nginx.conf.template "$tmp_dir/etc/nginx/templates/nginx.conf.template"

cat > "$fake_bin/envsubst" <<'ENVSUBST'
#!/bin/sh
set -eu

awk '{
  gsub(/\$\{RPC_PROXY_LISTEN_PORT\}/, ENVIRON["RPC_PROXY_LISTEN_PORT"])
  gsub(/\$\{RPC_UPSTREAM_SCHEME\}/, ENVIRON["RPC_UPSTREAM_SCHEME"])
  gsub(/\$\{RPC_UPSTREAM_HOST\}/, ENVIRON["RPC_UPSTREAM_HOST"])
  gsub(/\$\{RPC_UPSTREAM_TLS_HOST\}/, ENVIRON["RPC_UPSTREAM_TLS_HOST"])
  gsub(/\$\{RPC_UPSTREAM_PATH\}/, ENVIRON["RPC_UPSTREAM_PATH"])
  print
}'
ENVSUBST
chmod 0755 "$fake_bin/envsubst"

sed \
  -e "s#/usr/local/bin/derive-upstream.sh#$tmp_dir/usr/local/bin/derive-upstream.sh#g" \
  -e "s#/etc/nginx/templates/nginx.conf.template#$tmp_dir/etc/nginx/templates/nginx.conf.template#g" \
  -e "s#/etc/nginx/nginx.conf#$rendered_config#g" \
  docker/docker-entrypoint.sh > "$entrypoint"
chmod 0755 "$entrypoint"

run_entrypoint_with_port() {
  local port="$1"
  local label="$2"
  local stdout_file="$tmp_dir/$label.stdout"
  local stderr_file="$tmp_dir/$label.stderr"

  rm -f "$rendered_config"

  if ! RPC_UPSTREAM_URL="$SAFE_RPC_UPSTREAM_URL" RPC_PROXY_LISTEN_PORT="$port" PATH="$fake_bin:$PATH" "$entrypoint" true >"$stdout_file" 2>"$stderr_file"; then
    printf 'FAIL %s unexpectedly failed\n' "$label" >&2
    cat "$stderr_file" >&2
    exit 1
  fi
}

run_entrypoint_with_unset_port() {
  local label="$1"
  local stdout_file="$tmp_dir/$label.stdout"
  local stderr_file="$tmp_dir/$label.stderr"

  rm -f "$rendered_config"

  if ! (
    unset RPC_PROXY_LISTEN_PORT
    export RPC_UPSTREAM_URL="$SAFE_RPC_UPSTREAM_URL"
    export PATH="$fake_bin:$PATH"
    "$entrypoint" true
  ) >"$stdout_file" 2>"$stderr_file"; then
    printf 'FAIL %s unexpectedly failed\n' "$label" >&2
    cat "$stderr_file" >&2
    exit 1
  fi
}

assert_port_failure() {
  local port="$1"
  local label="$2"
  local stdout_file="$tmp_dir/$label.stdout"
  local stderr_file="$tmp_dir/$label.stderr"

  if RPC_UPSTREAM_URL="$SAFE_RPC_UPSTREAM_URL" RPC_PROXY_LISTEN_PORT="$port" PATH="$fake_bin:$PATH" "$entrypoint" true >"$stdout_file" 2>"$stderr_file"; then
    printf 'FAIL %s unexpectedly passed\n' "$label" >&2
    exit 1
  fi

  if ! grep -F -q -- "$PORT_ERROR_MESSAGE" "$stderr_file"; then
    printf 'FAIL %s error was not actionable\n' "$label" >&2
    cat "$stderr_file" >&2
    exit 1
  fi
}

run_entrypoint_with_port "8545" "explicit-port"
assert_file_contains "$rendered_config" "listen 8545;" "explicit safe listen port"
assert_file_contains "$rendered_config" "proxy_pass https://rpc-provider.invalid/v2/key;" "explicit safe upstream URL"
assert_file_contains "$rendered_config" 'proxy_set_header Authorization "";' "cleared authorization header"
assert_file_contains "$rendered_config" 'proxy_set_header Proxy-Authorization "";' "cleared proxy authorization header"
assert_file_contains "$rendered_config" 'proxy_set_header Cookie "";' "cleared cookie header"

run_entrypoint_with_unset_port "default-port"
assert_file_contains "$rendered_config" "listen 8545;" "default listen port"

assert_port_failure "8545; error_log /dev/stdout info" "directive-injection-port"
assert_port_failure "" "empty-port"
assert_port_failure "0" "zero-port"
assert_port_failure "65536" "above-range-port"

printf 'PASS entrypoint\n'
```

Write `scripts/test-nginx-routing.sh` as a runtime Docker test that starts a local Node upstream server, runs the built `rpc-proxy-nginx:local` image with `RPC_UPSTREAM_URL=http://host.docker.internal:<local-port>/v2/key?auth=placeholder`, verifies `/` reaches upstream as exactly `/v2/key?auth=placeholder`, verifies `/` with `Host: ping` and `Host: containerstarthealthcheck` returns 204 without reaching upstream, verifies `/?client=1` returns 404 without reaching upstream, and verifies `/foo` returns 404.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bash scripts/test-derive-upstream.sh
bash scripts/test-entrypoint.sh
docker build -t rpc-proxy-nginx:local .
bash scripts/test-nginx-routing.sh
```

Expected: FAIL because unsafe nginx config characters, raw `$` in `RPC_UPSTREAM_URL`, invalid upstream ports, IPv6 literals, invalid `RPC_PROXY_LISTEN_PORT` values, cleared client secret headers, and client query string rejection are not handled yet. The routing test should show `/?client=1` is forwarded before the nginx guard is added.

- [ ] **Step 3: Implement upstream derivation**

Write `docker/derive-upstream.sh`:

```sh
#!/bin/sh
set -eu

: "${RPC_UPSTREAM_URL:?RPC_UPSTREAM_URL is required}"

UNSAFE_NGINX_CONFIG_MESSAGE='RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration'
INVALID_UPSTREAM_AUTHORITY_MESSAGE='RPC_UPSTREAM_URL must use a DNS hostname with optional port'
INVALID_UPSTREAM_PORT_MESSAGE='RPC_UPSTREAM_URL port must be a number from 1 to 65535'

case "$RPC_UPSTREAM_URL" in
  *";"*|*"{"*|*"}"*|*'$'*|*[[:space:]]*)
    printf '%s\n' "$UNSAFE_NGINX_CONFIG_MESSAGE" >&2
    exit 1
    ;;
esac

case "$RPC_UPSTREAM_URL" in
  http://*|https://*) ;;
  *)
    printf 'RPC_UPSTREAM_URL must start with http:// or https://\n' >&2
    exit 1
    ;;
esac

RPC_UPSTREAM_SCHEME="${RPC_UPSTREAM_URL%%://*}"
RPC_UPSTREAM_REST="${RPC_UPSTREAM_URL#*://}"

case "$RPC_UPSTREAM_URL" in
  *'#'*)
    printf 'RPC_UPSTREAM_URL must not include a fragment\n' >&2
    exit 1
    ;;
esac

RPC_UPSTREAM_AUTHORITY="${RPC_UPSTREAM_REST%%[/?]*}"
RPC_UPSTREAM_PATH_SUFFIX="${RPC_UPSTREAM_REST#$RPC_UPSTREAM_AUTHORITY}"

case "$RPC_UPSTREAM_PATH_SUFFIX" in
  '')
    RPC_UPSTREAM_PATH="/"
    ;;
  /*)
    RPC_UPSTREAM_PATH="$RPC_UPSTREAM_PATH_SUFFIX"
    ;;
  \?*)
    RPC_UPSTREAM_PATH="/$RPC_UPSTREAM_PATH_SUFFIX"
    ;;
esac

if [ -z "$RPC_UPSTREAM_AUTHORITY" ]; then
  printf 'RPC_UPSTREAM_URL must include a host\n' >&2
  exit 1
fi

case "$RPC_UPSTREAM_AUTHORITY" in
  *@*)
    printf 'RPC_UPSTREAM_URL must not include userinfo\n' >&2
    exit 1
    ;;
esac

case "$RPC_UPSTREAM_AUTHORITY" in
  *"["*|*"]"*|*:*:*)
    printf '%s\n' "$INVALID_UPSTREAM_AUTHORITY_MESSAGE" >&2
    exit 1
    ;;
esac

case "$RPC_UPSTREAM_AUTHORITY" in
  *:*)
    RPC_UPSTREAM_TLS_HOST="${RPC_UPSTREAM_AUTHORITY%%:*}"
    RPC_UPSTREAM_PORT="${RPC_UPSTREAM_AUTHORITY#*:}"

    if [ -z "$RPC_UPSTREAM_TLS_HOST" ]; then
      printf 'RPC_UPSTREAM_URL must include a host\n' >&2
      exit 1
    fi

    case "$RPC_UPSTREAM_PORT" in
      ''|*[!0123456789]*)
        printf '%s\n' "$INVALID_UPSTREAM_PORT_MESSAGE" >&2
        exit 1
        ;;
    esac

    RPC_UPSTREAM_PORT_VALUE="$RPC_UPSTREAM_PORT"
    while [ "${RPC_UPSTREAM_PORT_VALUE#0}" != "$RPC_UPSTREAM_PORT_VALUE" ]; do
      RPC_UPSTREAM_PORT_VALUE="${RPC_UPSTREAM_PORT_VALUE#0}"
    done

    case "$RPC_UPSTREAM_PORT_VALUE" in
      '')
        printf '%s\n' "$INVALID_UPSTREAM_PORT_MESSAGE" >&2
        exit 1
        ;;
      ??????*)
        printf '%s\n' "$INVALID_UPSTREAM_PORT_MESSAGE" >&2
        exit 1
        ;;
    esac

    if [ "$RPC_UPSTREAM_PORT_VALUE" -gt 65535 ]; then
      printf '%s\n' "$INVALID_UPSTREAM_PORT_MESSAGE" >&2
      exit 1
    fi

    RPC_UPSTREAM_HOST="$RPC_UPSTREAM_AUTHORITY"
    ;;
  *)
    RPC_UPSTREAM_HOST="$RPC_UPSTREAM_AUTHORITY"
    RPC_UPSTREAM_TLS_HOST="$RPC_UPSTREAM_AUTHORITY"
    ;;
esac

if [ -z "$RPC_UPSTREAM_TLS_HOST" ]; then
  printf 'RPC_UPSTREAM_URL must include a host\n' >&2
  exit 1
fi

export RPC_UPSTREAM_SCHEME
export RPC_UPSTREAM_HOST
export RPC_UPSTREAM_TLS_HOST
export RPC_UPSTREAM_PATH
```

- [ ] **Step 4: Run the derivation test to verify it passes**

Run:

```bash
bash scripts/test-derive-upstream.sh
```

Expected: `PASS derive-upstream`.

- [ ] **Step 5: Write nginx template and entrypoint**

Write `docker/nginx.conf.template`:

```nginx
events {}

http {
    access_log off;
    error_log /dev/null crit;

    server {
        listen ${RPC_PROXY_LISTEN_PORT};

        location = / {
            if ($args != "") {
                return 404;
            }

            proxy_pass ${RPC_UPSTREAM_SCHEME}://${RPC_UPSTREAM_HOST}${RPC_UPSTREAM_PATH};
            proxy_ssl_server_name on;
            proxy_ssl_name ${RPC_UPSTREAM_TLS_HOST};
            proxy_set_header Host ${RPC_UPSTREAM_HOST};
            proxy_set_header Authorization "";
            proxy_set_header Proxy-Authorization "";
            proxy_set_header Cookie "";
            proxy_pass_request_headers on;
            proxy_buffering off;
            proxy_request_buffering off;
        }

        location / {
            return 404;
        }
    }
}
```

Write `docker/docker-entrypoint.sh`:

```sh
#!/bin/sh
set -eu

. /usr/local/bin/derive-upstream.sh

RPC_PROXY_LISTEN_PORT_ERROR='RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535'

if [ "${RPC_PROXY_LISTEN_PORT+x}" != 'x' ]; then
  RPC_PROXY_LISTEN_PORT=8545
elif [ -z "$RPC_PROXY_LISTEN_PORT" ]; then
  printf '%s\n' "$RPC_PROXY_LISTEN_PORT_ERROR" >&2
  exit 1
fi

case "$RPC_PROXY_LISTEN_PORT" in
  *[!0123456789]*)
    printf '%s\n' "$RPC_PROXY_LISTEN_PORT_ERROR" >&2
    exit 1
    ;;
esac

RPC_PROXY_LISTEN_PORT_NUMBER="$RPC_PROXY_LISTEN_PORT"
while [ "${RPC_PROXY_LISTEN_PORT_NUMBER#0}" != "$RPC_PROXY_LISTEN_PORT_NUMBER" ]; do
  RPC_PROXY_LISTEN_PORT_NUMBER="${RPC_PROXY_LISTEN_PORT_NUMBER#0}"
done

if [ -z "$RPC_PROXY_LISTEN_PORT_NUMBER" ]; then
  printf '%s\n' "$RPC_PROXY_LISTEN_PORT_ERROR" >&2
  exit 1
fi

if [ "${#RPC_PROXY_LISTEN_PORT_NUMBER}" -gt 5 ]; then
  printf '%s\n' "$RPC_PROXY_LISTEN_PORT_ERROR" >&2
  exit 1
fi

if [ "${#RPC_PROXY_LISTEN_PORT_NUMBER}" -eq 5 ] && [ "$RPC_PROXY_LISTEN_PORT_NUMBER" \> '65535' ]; then
  printf '%s\n' "$RPC_PROXY_LISTEN_PORT_ERROR" >&2
  exit 1
fi

export RPC_PROXY_LISTEN_PORT

envsubst '${RPC_PROXY_LISTEN_PORT} ${RPC_UPSTREAM_SCHEME} ${RPC_UPSTREAM_HOST} ${RPC_UPSTREAM_TLS_HOST} ${RPC_UPSTREAM_PATH}' \
  < /etc/nginx/templates/nginx.conf.template \
  > /etc/nginx/nginx.conf

exec "$@"
```

- [ ] **Step 6: Write Docker ignore, Docker, and Compose files**

Write `.dockerignore`:

```gitignore
.env
.env.*
!.env.example
.dev.vars*
.git
node_modules/
npm-debug.log*
logs/
coverage/
dist/
.wrangler/
docker/generated/
*.log
```

Write `Dockerfile`:

```Dockerfile
FROM nginx:1.27.5-alpine

COPY docker/derive-upstream.sh /usr/local/bin/derive-upstream.sh
COPY docker/docker-entrypoint.sh /usr/local/bin/rpc-proxy-entrypoint.sh
COPY docker/nginx.conf.template /etc/nginx/templates/nginx.conf.template

RUN chmod 0755 /usr/local/bin/derive-upstream.sh /usr/local/bin/rpc-proxy-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/rpc-proxy-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
```

Write `docker-compose.example.yml`:

```yaml
services:
  rpc-proxy:
    build:
      context: .
    image: rpc-proxy-nginx:local
    restart: unless-stopped
    environment:
      RPC_UPSTREAM_URL: "${RPC_UPSTREAM_URL:?set RPC_UPSTREAM_URL in an uncommitted env file}"
      RPC_PROXY_LISTEN_PORT: "${RPC_PROXY_LISTEN_PORT:-8545}"
    ports:
      - "${RPC_PROXY_PUBLISHED_PORT:-8545}:${RPC_PROXY_LISTEN_PORT:-8545}"
```

- [ ] **Step 7: Verify Docker config rendering and routing**

Run:

```bash
bash scripts/test-entrypoint.sh
```

Expected: `PASS entrypoint`.

Run:

```bash
docker build -t rpc-proxy-nginx:local .
```

Expected: image builds successfully from `nginx:1.27.5-alpine`.

Run:

```bash
bash scripts/test-nginx-routing.sh
```

Expected: `PASS nginx-routing`, proving root requests preserve the configured upstream query string, client query strings return 404 without forwarding, and non-root paths return 404.

Run:

```bash
docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL=https://rpc-provider.invalid:443/v2/key rpc-proxy-nginx:local nginx -T | grep -q 'proxy_ssl_name rpc-provider.invalid;'
```

Expected: command exits `0`, proving SNI uses the hostname without the port.

Run:

```bash
docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL=https://rpc-provider.invalid:443/v2/key rpc-proxy-nginx:local nginx -T | grep -q 'proxy_set_header Host rpc-provider.invalid:443;'
```

Expected: command exits `0`, proving the upstream `Host` header keeps the configured port.

Run:

```bash
docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL='https://rpc-provider.invalid/v2/key?chain=mainnet' rpc-proxy-nginx:local nginx -t
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`.

Run:

```bash
docker run --rm rpc-proxy-nginx:local nginx -t
```

Expected: non-zero exit with `RPC_UPSTREAM_URL is required`.

Run:

```bash
docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL='https://rpc-provider.invalid/v2/key;error_log /dev/stdout info' rpc-proxy-nginx:local nginx -t
```

Expected: non-zero exit with `RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration`.

Run:

```bash
invalid_upstream_port_output="$(mktemp)"
if docker run --rm -e 'RPC_UPSTREAM_URL=https://rpc-provider.invalid:99999/v2/key?api_key=placeholder' rpc-proxy-nginx:local nginx -t >"$invalid_upstream_port_output" 2>&1; then
  printf 'expected invalid RPC_UPSTREAM_URL port to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL port must be a number from 1 to 65535' "$invalid_upstream_port_output"
if grep -F -q '/v2/key' "$invalid_upstream_port_output" || grep -F -q 'placeholder' "$invalid_upstream_port_output"; then
  printf 'invalid upstream port error leaked URL path or query\n' >&2
  exit 1
fi
rm -f "$invalid_upstream_port_output"
```

Expected: non-zero exit with `RPC_UPSTREAM_URL port must be a number from 1 to 65535`, without printing the upstream path or query.

Run:

```bash
docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL=https://rpc-provider.invalid/v2/key -e 'RPC_PROXY_LISTEN_PORT=8545; error_log /dev/stdout info' rpc-proxy-nginx:local nginx -t
```

Expected: non-zero exit with `RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535`.

- [ ] **Step 8: Commit nginx proxy files**

Run:

```bash
git add .dockerignore Dockerfile docker docker-compose.example.yml scripts/test-derive-upstream.sh scripts/test-entrypoint.sh scripts/test-nginx-routing.sh docs/superpowers/plans/2026-05-11-rpc-proxy-deployment.md
git commit -m "fix: harden nginx proxy configuration"
```

Expected: commit succeeds.

### Task 3: Cloudflare Worker Free Proxy

**Files:**
- Create: `cloudflare/worker.test.mjs`
- Create: `cloudflare/worker.mjs`
- Create: `wrangler.free.example.toml`

- [ ] **Step 1: Write failing Worker tests**

Write `cloudflare/worker.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "./worker.mjs";

const ENV = Object.freeze({
  RPC_UPSTREAM_URL: "https://rpc-provider.invalid/v2/key",
  RPC_PROXY_PATH_TOKEN: "test-route-token",
});

test("rejects requests to the wrong path without forwarding", async () => {
  let fetchCalled = false;
  const request = new Request("https://proxy.invalid/rpc/wrong-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleRequest(request, ENV, async () => {
    fetchCalled = true;
    return new Response("unexpected");
  });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal(fetchCalled, false);
});

test("forwards POST body to configured upstream URL", async () => {
  const body = '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}';
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.10",
    },
    body,
  });

  let forwardedRequest;
  const response = await handleRequest(request, ENV, async (upstreamRequest) => {
    forwardedRequest = upstreamRequest;
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(forwardedRequest.url, ENV.RPC_UPSTREAM_URL);
  assert.equal(forwardedRequest.method, "POST");
  assert.equal(forwardedRequest.headers.get("content-type"), "application/json");
  assert.equal(forwardedRequest.headers.has("x-forwarded-for"), false);
  assert.equal(await forwardedRequest.text(), body);
});

test("forwards GET without adding a request body", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "GET",
  });

  let forwardedRequest;
  const response = await handleRequest(request, ENV, async (upstreamRequest) => {
    forwardedRequest = upstreamRequest;
    return new Response("upstream get response", { status: 400 });
  });

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "upstream get response");
  assert.equal(forwardedRequest.method, "GET");
  assert.equal(forwardedRequest.body, null);
});

test("returns config error when upstream is missing", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleRequest(
    request,
    { RPC_PROXY_PATH_TOKEN: "test-route-token" },
    async () => new Response("unexpected"),
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Proxy upstream is not configured");
});

test("returns bad gateway when upstream fetch throws", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleRequest(request, ENV, async () => {
    throw new Error("network failed");
  });

  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Bad gateway");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test
```

Expected: FAIL with module-not-found for `cloudflare/worker.mjs`.

- [ ] **Step 3: Implement Worker proxy**

Write `cloudflare/worker.mjs`:

```js
const ENV_KEYS = Object.freeze({
  upstreamUrl: "RPC_UPSTREAM_URL",
  pathToken: "RPC_PROXY_PATH_TOKEN",
});

const HTTP_STATUS = Object.freeze({
  notFound: 404,
  configError: 500,
  badGateway: 502,
});

const RESPONSE_TEXT = Object.freeze({
  notFound: "Not found",
  missingUpstream: "Proxy upstream is not configured",
  missingPathToken: "Proxy path token is not configured",
  invalidUpstream: "Proxy upstream URL is invalid",
  badGateway: "Bad gateway",
});

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

const STRIPPED_HEADERS = Object.freeze([
  "connection",
  "content-length",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-real-ip",
]);

function getRequiredEnv(env, key) {
  const value = env?.[key];

  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function configError(message) {
  return new Response(message, { status: HTTP_STATUS.configError });
}

function validateUpstreamUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }

  return url.toString();
}

function expectedPath(pathToken) {
  return `/rpc/${pathToken}`;
}

function copyForwardHeaders(headers) {
  const forwardedHeaders = new Headers(headers);

  for (const headerName of STRIPPED_HEADERS) {
    forwardedHeaders.delete(headerName);
  }

  return forwardedHeaders;
}

export async function buildUpstreamRequest(request, upstreamUrl) {
  const init = {
    method: request.method,
    headers: copyForwardHeaders(request.headers),
    redirect: "manual",
  };

  if (!BODYLESS_METHODS.has(request.method)) {
    init.body = await request.arrayBuffer();
  }

  return new Request(upstreamUrl, init);
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const upstreamValue = getRequiredEnv(env, ENV_KEYS.upstreamUrl);
  if (!upstreamValue) {
    return configError(RESPONSE_TEXT.missingUpstream);
  }

  const pathToken = getRequiredEnv(env, ENV_KEYS.pathToken);
  if (!pathToken) {
    return configError(RESPONSE_TEXT.missingPathToken);
  }

  const upstreamUrl = validateUpstreamUrl(upstreamValue);
  if (!upstreamUrl) {
    return configError(RESPONSE_TEXT.invalidUpstream);
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== expectedPath(pathToken)) {
    return new Response(RESPONSE_TEXT.notFound, { status: HTTP_STATUS.notFound });
  }

  try {
    const upstreamRequest = await buildUpstreamRequest(request, upstreamUrl);
    return await fetchImpl(upstreamRequest);
  } catch {
    return new Response(RESPONSE_TEXT.badGateway, { status: HTTP_STATUS.badGateway });
  }
}

export default {
  fetch: handleRequest,
};
```

- [ ] **Step 4: Run Worker tests to verify they pass**

Run:

```bash
npm test
```

Expected: all `cloudflare/worker.test.mjs` tests pass.

- [ ] **Step 5: Add Worker Free Wrangler template**

Write `wrangler.free.example.toml`:

```toml
name = "rpc-proxy-free"
main = "cloudflare/worker.mjs"
compatibility_date = "2026-05-11"
workers_dev = true

# Set both sensitive values as Cloudflare secrets:
# npx wrangler secret put RPC_UPSTREAM_URL --config wrangler.free.example.toml
# npx wrangler secret put RPC_PROXY_PATH_TOKEN --config wrangler.free.example.toml
```

- [ ] **Step 6: Dry-run Worker Free deployment**

Run:

```bash
npm run dry-run:worker:free
```

Expected: Wrangler bundles the Worker without deploying.

- [ ] **Step 7: Commit Worker Free files**

Run:

```bash
git add cloudflare/worker.mjs cloudflare/worker.test.mjs wrangler.free.example.toml package.json package-lock.json
git commit -m "feat: add cloudflare worker rpc proxy"
```

Expected: commit succeeds.

### Task 4: Cloudflare Containers Paid Path

**Files:**
- Create: `cloudflare/container-worker.test.mjs`
- Create: `cloudflare/container-worker.mjs`
- Create: `wrangler.containers.example.toml`

- [ ] **Step 1: Write failing Cloudflare Containers Worker tests**

Write `cloudflare/container-worker.test.mjs` with Node built-in tests and mocked container lookup. Tests must prove:

- Wrong path returns 404 and does not call `getContainer`.
- Correct path with query string returns 404 and does not call `getContainer`.
- Missing upstream or path token returns 500 without container lookup.
- Valid requests start the named `rpc-proxy` container with `RPC_UPSTREAM_URL` and `RPC_PROXY_LISTEN_PORT=8545`, wait on port 8545, rewrite the container request to `/` with no query string, preserve method and body, and call `container.fetch`.
- Valid requests strip `cf-container-target-port`, hop-by-hop headers, `Connection`-named headers, Cloudflare/client IP headers, sensitive client headers, and forwarding metadata headers including `via`, `x-forwarded-host`, `x-forwarded-proto`, `x-forwarded-port`, `x-forwarded-server`, `x-client-ip`, and `x-cluster-client-ip`.

- [ ] **Step 2: Write Cloudflare Containers Worker**

Write `cloudflare/container-worker.mjs` with the same production behavior as the original Containers Worker, plus:

- Test injection for container lookup, e.g. `handleContainerRequest(request, env, { getContainerImpl = getContainer })`.
- Node test import support without requiring real Cloudflare bindings.
- Exact route matching on `/rpc/<RPC_PROXY_PATH_TOKEN>` with an empty query string.
- `cf-container-target-port` stripping before `container.fetch()` so a route-token holder cannot override the target container port.
- Broadened forwarding metadata stripping for `via`, `x-forwarded-host`, `x-forwarded-proto`, `x-forwarded-port`, `x-forwarded-server`, `x-client-ip`, and `x-cluster-client-ip`.

- [ ] **Step 3: Write Cloudflare Containers Wrangler template**

Write `wrangler.containers.example.toml`:

```toml
name = "rpc-proxy-containers"
main = "cloudflare/container-worker.mjs"
compatibility_date = "2026-05-11"
workers_dev = true

[[containers]]
class_name = "RpcProxyContainer"
image = "./Dockerfile"
max_instances = 1

[[durable_objects.bindings]]
name = "RPC_PROXY_CONTAINER"
class_name = "RpcProxyContainer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RpcProxyContainer"]

# Set both sensitive values as Cloudflare secrets:
# npx wrangler secret put RPC_UPSTREAM_URL --config wrangler.containers.example.toml
# npx wrangler secret put RPC_PROXY_PATH_TOKEN --config wrangler.containers.example.toml
```

- [ ] **Step 4: Verify Cloudflare Containers Worker and nginx health routing**

Run:

```bash
npm test
node --check cloudflare/container-worker.mjs
bash scripts/test-nginx-routing.sh
npm run dry-run:containers
```

Expected: Node tests pass, the Containers Worker parses, nginx health-probe hosts return 204 without upstream requests, and Wrangler validates and bundles the Worker. A real deploy requires Workers Paid, Docker running locally, and Cloudflare Containers availability on the account.

- [ ] **Step 5: Commit Cloudflare Containers files**

Run:

```bash
git add cloudflare/container-worker.mjs cloudflare/container-worker.test.mjs wrangler.containers.example.toml package.json package-lock.json
git commit -m "feat: add cloudflare containers rpc proxy path"
```

Expected: commit succeeds.

### Task 5: Deployment Runbook and Final Verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write deployment runbook**

Write `README.md`:

````markdown
# RPC Proxy

Minimal JSON-RPC proxy with three deployment paths:

- nginx Docker on EC2 or any VM
- Cloudflare Worker Free without Docker
- Cloudflare Containers Paid with the nginx Docker image

Do not commit real RPC URLs, API keys, EC2 IPs, Cloudflare account IDs, Worker routes, or route tokens.

## Local nginx Docker

Create an uncommitted `.env` from `.env.example` and replace placeholder values:

```bash
cp .env.example .env
```

Run locally:

```bash
docker compose --env-file .env -f docker-compose.example.yml up --build -d
```

Verify:

```bash
curl -X POST http://127.0.0.1:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Expected: JSON-RPC response with a hex `result`.

## VM or EC2 nginx Docker

Build and run the same Docker image on the VM. Restrict inbound access to the published proxy port with a firewall or cloud security group. Do not expose the port to all source IPs.

Example command shape:

```bash
docker run -d --name rpc-proxy \
  --env-file /path/to/uncommitted-rpc-proxy.env \
  -p 8545:8545 \
  --restart unless-stopped \
  rpc-proxy-nginx:local
```

Set local clients to the VM proxy endpoint:

```dotenv
ETH_RPC_URL=http://<vm-host-or-ip>:8545
```

## Cloudflare Worker Free

Set secrets:

```bash
npx wrangler secret put RPC_UPSTREAM_URL --config wrangler.free.example.toml
npx wrangler secret put RPC_PROXY_PATH_TOKEN --config wrangler.free.example.toml
```

Deploy:

```bash
npm run deploy:worker:free
```

Set local clients to the Worker route:

```dotenv
ETH_RPC_URL=https://<worker-domain>/rpc/<route-token>
```

Cloudflare Workers Free is suitable for this proxy shape when usage stays below 100,000 requests per UTC day.

## Cloudflare Containers Paid

This path runs the nginx Docker image behind a Worker and Container binding. It requires Workers Paid and Docker running locally for deploys that build the image.

Set secrets:

```bash
npx wrangler secret put RPC_UPSTREAM_URL --config wrangler.containers.example.toml
npx wrangler secret put RPC_PROXY_PATH_TOKEN --config wrangler.containers.example.toml
```

Deploy:

```bash
npm run deploy:containers
```

Set local clients to the Containers-backed Worker route:

```dotenv
ETH_RPC_URL=https://<worker-domain>/rpc/<route-token>
```

## Verification

Run local tests:

```bash
npm test
bash scripts/test-derive-upstream.sh
bash scripts/test-entrypoint.sh
docker build -t rpc-proxy-nginx:local .
bash scripts/test-nginx-routing.sh
unsafe_url_output="$(mktemp)"
if docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL='https://rpc-provider.invalid/v2/key?auth=$http_authorization' rpc-proxy-nginx:local nginx -t >"$unsafe_url_output" 2>&1; then
  printf 'expected unsafe RPC_UPSTREAM_URL to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration' "$unsafe_url_output"
rm -f "$unsafe_url_output"
invalid_upstream_port_output="$(mktemp)"
if docker run --rm -e 'RPC_UPSTREAM_URL=https://rpc-provider.invalid:99999/v2/key?api_key=placeholder' rpc-proxy-nginx:local nginx -t >"$invalid_upstream_port_output" 2>&1; then
  printf 'expected invalid RPC_UPSTREAM_URL port to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL port must be a number from 1 to 65535' "$invalid_upstream_port_output"
if grep -F -q '/v2/key' "$invalid_upstream_port_output" || grep -F -q 'placeholder' "$invalid_upstream_port_output"; then
  printf 'invalid upstream port error leaked URL path or query\n' >&2
  exit 1
fi
rm -f "$invalid_upstream_port_output"
unsafe_port_output="$(mktemp)"
if docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL=https://rpc-provider.invalid/v2/key -e 'RPC_PROXY_LISTEN_PORT=8545; error_log /dev/stdout info' rpc-proxy-nginx:local nginx -t >"$unsafe_port_output" 2>&1; then
  printf 'expected unsafe RPC_PROXY_LISTEN_PORT to fail\n' >&2
  exit 1
fi
grep -F 'RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535' "$unsafe_port_output"
rm -f "$unsafe_port_output"
npm run dry-run:worker:free
npm run dry-run:containers
```

The routing test should prove `/` forwards to the configured upstream path and query exactly, `/` with `Host: ping` and `Host: containerstarthealthcheck` returns 204 without forwarding, `/?client=1` returns 404 without forwarding, and `/foo` returns 404. The Docker negative checks should exit non-zero with the unsafe upstream URL, invalid upstream port, and listen port validation messages. The invalid upstream port check must not print the upstream path or query.

Scan for accidental concrete RPC values before committing:

```bash
rg -n "RPC_UPSTREAM_URL=https://[^<]|RPC_PROXY_PATH_TOKEN=[^<]|/v2/[A-Za-z0-9_-]{10,}" \
  .env.example Dockerfile docker docker-compose.example.yml cloudflare wrangler.free.example.toml wrangler.containers.example.toml package.json
```

Expected: no matches for real provider hosts, real upstream URLs, or real route tokens.

## References

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Containers getting started: https://developers.cloudflare.com/containers/get-started/
- Cloudflare Containers interface: https://developers.cloudflare.com/containers/container-class/
- Cloudflare Containers env vars and secrets: https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
````

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
node --check cloudflare/container-worker.mjs
bash scripts/test-derive-upstream.sh
bash scripts/test-entrypoint.sh
docker build -t rpc-proxy-nginx:local .
bash scripts/test-nginx-routing.sh
unsafe_url_output="$(mktemp)"
if docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL='https://rpc-provider.invalid/v2/key?auth=$http_authorization' rpc-proxy-nginx:local nginx -t >"$unsafe_url_output" 2>&1; then
  printf 'expected unsafe RPC_UPSTREAM_URL to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration' "$unsafe_url_output"
rm -f "$unsafe_url_output"
invalid_upstream_port_output="$(mktemp)"
if docker run --rm -e 'RPC_UPSTREAM_URL=https://rpc-provider.invalid:99999/v2/key?api_key=placeholder' rpc-proxy-nginx:local nginx -t >"$invalid_upstream_port_output" 2>&1; then
  printf 'expected invalid RPC_UPSTREAM_URL port to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL port must be a number from 1 to 65535' "$invalid_upstream_port_output"
if grep -F -q '/v2/key' "$invalid_upstream_port_output" || grep -F -q 'placeholder' "$invalid_upstream_port_output"; then
  printf 'invalid upstream port error leaked URL path or query\n' >&2
  exit 1
fi
rm -f "$invalid_upstream_port_output"
unsafe_port_output="$(mktemp)"
if docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e RPC_UPSTREAM_URL=https://rpc-provider.invalid/v2/key -e 'RPC_PROXY_LISTEN_PORT=8545; error_log /dev/stdout info' rpc-proxy-nginx:local nginx -t >"$unsafe_port_output" 2>&1; then
  printf 'expected unsafe RPC_PROXY_LISTEN_PORT to fail\n' >&2
  exit 1
fi
grep -F 'RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535' "$unsafe_port_output"
rm -f "$unsafe_port_output"
npm run dry-run:worker:free
npm run dry-run:containers
rg -n "RPC_UPSTREAM_URL=https://[^<]|RPC_PROXY_PATH_TOKEN=[^<]|/v2/[A-Za-z0-9_-]{10,}" \
  .env.example Dockerfile docker docker-compose.example.yml cloudflare wrangler.free.example.toml wrangler.containers.example.toml package.json
```

Expected:

- `npm test` passes.
- `node --check cloudflare/container-worker.mjs` exits `0`.
- `bash scripts/test-derive-upstream.sh` prints `PASS derive-upstream`.
- `bash scripts/test-entrypoint.sh` prints `PASS entrypoint`.
- Docker image builds.
- `bash scripts/test-nginx-routing.sh` prints `PASS nginx-routing`.
- Docker negative checks exit non-zero with `RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration`, `RPC_UPSTREAM_URL port must be a number from 1 to 65535`, and `RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535`.
- The invalid upstream port error does not print the upstream path or query.
- Wrangler dry-runs finish without deploying.
- `rg` returns no matches for real provider hosts, real upstream URLs, or real route tokens.

- [ ] **Step 3: Commit runbook**

Run:

```bash
git add README.md
git commit -m "docs: add rpc proxy deployment runbook"
```

Expected: commit succeeds.

## Self-Review Checklist

- Spec coverage: nginx Docker, Cloudflare Worker Free, Cloudflare Containers Paid, one `RPC_UPSTREAM_URL`, secret path token, GET pass-through, no committed real URLs, SNI, nginx config input validation, client query string rejection, client secret header clearing, and verification are covered.
- Placeholder scan: the plan uses explicit placeholder values with `<...>` where secrets or account-specific values belong. It does not include a real upstream RPC URL or provider API key.
- Type consistency: Worker env names are `RPC_UPSTREAM_URL` and `RPC_PROXY_PATH_TOKEN` throughout. Container binding is `RPC_PROXY_CONTAINER` throughout. nginx listen port is `8545` by default and validates `RPC_PROXY_LISTEN_PORT` before rendering.
