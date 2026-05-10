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
