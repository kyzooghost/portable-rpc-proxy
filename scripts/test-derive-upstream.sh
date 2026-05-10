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
  RPC_UPSTREAM_URL="$1" sh -c '. ./docker/derive-upstream.sh; printf "%s|%s|%s\n" "$RPC_UPSTREAM_SCHEME" "$RPC_UPSTREAM_HOST" "$RPC_UPSTREAM_PATH"'
}

assert_equals "https|rpc-provider.invalid|/v2/key" "$(derive "https://rpc-provider.invalid/v2/key")" "https URL with path"
assert_equals "http|rpc-provider.invalid|/" "$(derive "http://rpc-provider.invalid")" "http URL without path"

if RPC_UPSTREAM_URL="ftp://rpc-provider.invalid/path" sh -c '. ./docker/derive-upstream.sh' >/tmp/rpc-proxy-test.out 2>/tmp/rpc-proxy-test.err; then
  printf 'FAIL invalid scheme unexpectedly passed\n' >&2
  exit 1
fi

if ! rg -q "RPC_UPSTREAM_URL must start with http:// or https://" /tmp/rpc-proxy-test.err; then
  printf 'FAIL invalid scheme error was not actionable\n' >&2
  cat /tmp/rpc-proxy-test.err >&2
  exit 1
fi

printf 'PASS derive-upstream\n'
