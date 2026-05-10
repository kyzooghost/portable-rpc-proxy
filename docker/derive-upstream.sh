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
