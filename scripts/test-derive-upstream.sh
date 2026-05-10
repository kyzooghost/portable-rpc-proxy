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

assert_equals "https|rpc-provider.invalid|rpc-provider.invalid|/v2/key" "$(derive "https://rpc-provider.invalid/v2/key")" "https URL with path"
assert_equals "http|rpc-provider.invalid|rpc-provider.invalid|/" "$(derive "http://rpc-provider.invalid")" "http URL without path"
assert_equals "https|rpc-provider.invalid|rpc-provider.invalid|/v2/key?chain=mainnet" "$(derive "https://rpc-provider.invalid/v2/key?chain=mainnet")" "https URL with path and query"
assert_equals "https|rpc-provider.invalid|rpc-provider.invalid|/?api_key=key" "$(derive "https://rpc-provider.invalid?api_key=key")" "https root URL with query"
assert_equals "https|rpc-provider.invalid:443|rpc-provider.invalid|/v2/key" "$(derive "https://rpc-provider.invalid:443/v2/key")" "https URL with port"

assert_failure "ftp://rpc-provider.invalid/path" "RPC_UPSTREAM_URL must start with http:// or https://" "invalid scheme"
assert_failure "https:///v2/key" "RPC_UPSTREAM_URL must include a host" "empty host"
assert_failure "https://user:pass@rpc-provider.invalid/v2/key" "RPC_UPSTREAM_URL must not include userinfo" "userinfo"
assert_failure "https://rpc-provider.invalid/v2/key#frag" "RPC_UPSTREAM_URL must not include a fragment" "fragment"

printf 'PASS derive-upstream\n'
