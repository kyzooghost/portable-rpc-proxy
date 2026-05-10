#!/bin/sh
set -eu

. /usr/local/bin/derive-upstream.sh

RPC_PROXY_LISTEN_PORT="${RPC_PROXY_LISTEN_PORT:-8545}"
export RPC_PROXY_LISTEN_PORT

envsubst '${RPC_PROXY_LISTEN_PORT} ${RPC_UPSTREAM_SCHEME} ${RPC_UPSTREAM_HOST} ${RPC_UPSTREAM_TLS_HOST} ${RPC_UPSTREAM_PATH}' \
  < /etc/nginx/templates/nginx.conf.template \
  > /etc/nginx/nginx.conf

exec "$@"
