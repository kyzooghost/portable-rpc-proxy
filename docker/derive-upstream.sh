#!/bin/sh
set -eu

: "${RPC_UPSTREAM_URL:?RPC_UPSTREAM_URL is required}"

UNSAFE_NGINX_CONFIG_MESSAGE='RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration'
INVALID_UPSTREAM_AUTHORITY_MESSAGE='RPC_UPSTREAM_URL must use a DNS hostname with optional port'
INVALID_UPSTREAM_PORT_MESSAGE='RPC_UPSTREAM_URL port must be a number from 1 to 65535'
DNS_HOSTNAME_MAX_LENGTH=253

validate_dns_hostname() {
  DNS_HOSTNAME_REST="$1"

  if [ "${#DNS_HOSTNAME_REST}" -gt "$DNS_HOSTNAME_MAX_LENGTH" ]; then
    return 1
  fi

  case "$DNS_HOSTNAME_REST" in
    ''|.*|*.|*..*)
      return 1
      ;;
  esac

  while :; do
    case "$DNS_HOSTNAME_REST" in
      *.*)
        DNS_HOSTNAME_LABEL="${DNS_HOSTNAME_REST%%.*}"
        DNS_HOSTNAME_REST="${DNS_HOSTNAME_REST#*.}"
        ;;
      *)
        DNS_HOSTNAME_LABEL="$DNS_HOSTNAME_REST"
        DNS_HOSTNAME_REST=''
        ;;
    esac

    case "$DNS_HOSTNAME_LABEL" in
      ''|-*|*-|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-]*)
        return 1
        ;;
    esac

    if [ "${#DNS_HOSTNAME_LABEL}" -gt 63 ]; then
      return 1
    fi

    if [ -z "$DNS_HOSTNAME_REST" ]; then
      return 0
    fi
  done
}

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
    RPC_UPSTREAM_CONNECT_HOST="$RPC_UPSTREAM_AUTHORITY"
    ;;
  *)
    RPC_UPSTREAM_HOST="$RPC_UPSTREAM_AUTHORITY"
    RPC_UPSTREAM_TLS_HOST="$RPC_UPSTREAM_AUTHORITY"

    case "$RPC_UPSTREAM_SCHEME" in
      https)
        RPC_UPSTREAM_CONNECT_HOST="$RPC_UPSTREAM_AUTHORITY:443"
        ;;
      http)
        RPC_UPSTREAM_CONNECT_HOST="$RPC_UPSTREAM_AUTHORITY:80"
        ;;
    esac
    ;;
esac

if [ -z "$RPC_UPSTREAM_TLS_HOST" ]; then
  printf 'RPC_UPSTREAM_URL must include a host\n' >&2
  exit 1
fi

if ! validate_dns_hostname "$RPC_UPSTREAM_TLS_HOST"; then
  printf '%s\n' "$INVALID_UPSTREAM_AUTHORITY_MESSAGE" >&2
  exit 1
fi

case "$RPC_UPSTREAM_PATH" in
  *\?*)
    RPC_CLIENT_QUERY_SEPARATOR='&'
    ;;
  *)
    RPC_CLIENT_QUERY_SEPARATOR='?'
    ;;
esac

export RPC_UPSTREAM_SCHEME
export RPC_UPSTREAM_HOST
export RPC_UPSTREAM_CONNECT_HOST
export RPC_UPSTREAM_TLS_HOST
export RPC_UPSTREAM_PATH
export RPC_CLIENT_QUERY_SEPARATOR
