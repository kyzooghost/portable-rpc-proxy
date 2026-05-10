#!/bin/sh
set -eu

: "${RPC_UPSTREAM_URL:?RPC_UPSTREAM_URL is required}"

UNSAFE_NGINX_CONFIG_MESSAGE='RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration'

case "$RPC_UPSTREAM_URL" in
  *";"*|*"{"*|*"}"*|*[[:space:]]*)
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

RPC_UPSTREAM_HOST="${RPC_UPSTREAM_REST%%[/?]*}"
RPC_UPSTREAM_PATH_SUFFIX="${RPC_UPSTREAM_REST#$RPC_UPSTREAM_HOST}"

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

if [ -z "$RPC_UPSTREAM_HOST" ]; then
  printf 'RPC_UPSTREAM_URL must include a host\n' >&2
  exit 1
fi

case "$RPC_UPSTREAM_HOST" in
  *@*)
    printf 'RPC_UPSTREAM_URL must not include userinfo\n' >&2
    exit 1
    ;;
esac

RPC_UPSTREAM_TLS_HOST="${RPC_UPSTREAM_HOST%%:*}"

if [ -z "$RPC_UPSTREAM_TLS_HOST" ]; then
  printf 'RPC_UPSTREAM_URL must include a host\n' >&2
  exit 1
fi

export RPC_UPSTREAM_SCHEME
export RPC_UPSTREAM_HOST
export RPC_UPSTREAM_TLS_HOST
export RPC_UPSTREAM_PATH
