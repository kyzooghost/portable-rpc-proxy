#!/bin/sh
set -eu

: "${RPC_UPSTREAM_URL:?RPC_UPSTREAM_URL is required}"

case "$RPC_UPSTREAM_URL" in
  http://*|https://*) ;;
  *)
    printf 'RPC_UPSTREAM_URL must start with http:// or https://\n' >&2
    exit 1
    ;;
esac

RPC_UPSTREAM_SCHEME="${RPC_UPSTREAM_URL%%://*}"
RPC_UPSTREAM_REST="${RPC_UPSTREAM_URL#*://}"

case "$RPC_UPSTREAM_REST" in
  */*)
    RPC_UPSTREAM_HOST="${RPC_UPSTREAM_REST%%/*}"
    RPC_UPSTREAM_PATH="/${RPC_UPSTREAM_REST#*/}"
    ;;
  *)
    RPC_UPSTREAM_HOST="$RPC_UPSTREAM_REST"
    RPC_UPSTREAM_PATH="/"
    ;;
esac

if [ -z "$RPC_UPSTREAM_HOST" ]; then
  printf 'RPC_UPSTREAM_URL must include a host\n' >&2
  exit 1
fi

export RPC_UPSTREAM_SCHEME
export RPC_UPSTREAM_HOST
export RPC_UPSTREAM_PATH
