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

line_count() {
  wc -l <"$url_log" | tr -d ' '
}

request_status() {
  local url="$1"
  local label="$2"
  local status

  if ! status="$(curl -sS -o "$tmp_dir/$label.body" -w '%{http_code}' "$url")"; then
    printf 'FAIL %s curl request failed\n' "$label" >&2
    exit 1
  fi

  printf '%s\n' "$status"
}

wait_for_file() {
  local file="$1"
  local pid="$2"
  local label="$3"

  for _ in {1..100}; do
    if [[ -s "$file" ]]; then
      return
    fi

    if ! kill -0 "$pid" >/dev/null 2>&1; then
      printf 'FAIL %s process exited early\n' "$label" >&2
      if [[ -s "$server_stderr" ]]; then
        cat "$server_stderr" >&2
      fi
      exit 1
    fi

    sleep 0.1
  done

  printf 'FAIL timed out waiting for %s\n' "$label" >&2
  exit 1
}

wait_for_proxy() {
  local status

  for _ in {1..100}; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$published_port/foo" 2>/dev/null || true)"
    if [[ "$status" == "404" ]]; then
      return
    fi
    sleep 0.1
  done

  printf 'FAIL timed out waiting for nginx proxy on published port %s\n' "$published_port" >&2
  docker logs "$container_id" >&2 || true
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "${container_id:-}" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi

  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi

  rm -rf "$tmp_dir"
  exit "$status"
}

tmp_dir="$(mktemp -d)"
trap cleanup EXIT INT TERM

url_log="$tmp_dir/upstream-urls.log"
port_file="$tmp_dir/upstream-port"
server_script="$tmp_dir/upstream-server.cjs"
server_stdout="$tmp_dir/upstream-server.stdout"
server_stderr="$tmp_dir/upstream-server.stderr"
docker_run_stderr="$tmp_dir/docker-run.stderr"
container_name="rpc-proxy-routing-test-$$"
container_id=""
server_pid=""

: >"$url_log"

cat >"$server_script" <<'NODE'
const fs = require("node:fs");
const http = require("node:http");

const [urlLog, portFile] = process.argv.slice(2);

const server = http.createServer((request, response) => {
  fs.appendFileSync(urlLog, `${request.url}\n`);
  request.resume();
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});

server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

server.listen(0, "0.0.0.0", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
NODE

node "$server_script" "$url_log" "$port_file" >"$server_stdout" 2>"$server_stderr" &
server_pid=$!
wait_for_file "$port_file" "$server_pid" "upstream server"

upstream_port="$(cat "$port_file")"
run_args=(
  -d
  --rm
  --name "$container_name"
  -e "RPC_UPSTREAM_URL=http://host.docker.internal:$upstream_port/v2/key?auth=placeholder"
  -e "RPC_PROXY_LISTEN_PORT=8545"
  -p "127.0.0.1::8545"
  rpc-proxy-nginx:local
)

if ! container_id="$(docker run --add-host=host.docker.internal:host-gateway "${run_args[@]}" 2>"$docker_run_stderr")"; then
  if grep -F -q -- 'host-gateway' "$docker_run_stderr"; then
    container_id="$(docker run "${run_args[@]}")"
  else
    cat "$docker_run_stderr" >&2
    exit 1
  fi
fi

published_port="$(docker port "$container_id" 8545/tcp | awk -F: 'NR == 1 { print $NF }')"
if [[ -z "$published_port" ]]; then
  printf 'FAIL published port was not available\n' >&2
  docker logs "$container_id" >&2 || true
  exit 1
fi

wait_for_proxy

root_status="$(request_status "http://127.0.0.1:$published_port/" "root-request")"
assert_equals "200" "$root_status" "root request status"
assert_equals "1" "$(line_count)" "root request upstream count"
assert_equals "/v2/key?auth=placeholder" "$(sed -n '1p' "$url_log")" "root request upstream URL"

before_query_count="$(line_count)"
query_status="$(request_status "http://127.0.0.1:$published_port/?client=1" "query-request")"
assert_equals "404" "$query_status" "client query request status"
assert_equals "$before_query_count" "$(line_count)" "client query upstream count"

foo_status="$(request_status "http://127.0.0.1:$published_port/foo" "foo-request")"
assert_equals "404" "$foo_status" "non-root request status"
assert_equals "$before_query_count" "$(line_count)" "non-root request upstream count"

printf 'PASS nginx-routing\n'
