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
  gsub(/\$\{RPC_UPSTREAM_CONNECT_HOST\}/, ENVIRON["RPC_UPSTREAM_CONNECT_HOST"])
  gsub(/\$\{RPC_UPSTREAM_TLS_HOST\}/, ENVIRON["RPC_UPSTREAM_TLS_HOST"])
  gsub(/\$\{RPC_UPSTREAM_PATH\}/, ENVIRON["RPC_UPSTREAM_PATH"])
  gsub(/\$\{RPC_CLIENT_QUERY_SEPARATOR\}/, ENVIRON["RPC_CLIENT_QUERY_SEPARATOR"])
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
assert_file_contains "$rendered_config" 'default "?$args";' "client query separator for upstream URL without query"
assert_file_contains "$rendered_config" "server rpc-provider.invalid:443;" "explicit safe upstream connection authority"
assert_file_contains "$rendered_config" 'proxy_pass https://rpc_proxy_upstream/v2/key$rpc_client_query_suffix;' "explicit safe upstream URL"
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
