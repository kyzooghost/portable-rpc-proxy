# RPC Proxy

Minimal JSON-RPC proxy for environments where direct RPC provider subdomain access is blocked. The package gives local CLI tools and scripts one proxy URL while the proxy forwards to an upstream JSON-RPC provider URL configured at deployment time.

## Deployment Paths

- nginx Docker on a local machine, VM, EC2 instance, or any Docker host.
- Cloudflare Worker Free without Docker.
- Cloudflare Containers Paid with the nginx Docker image.

## Security Rules

- Do not commit real RPC provider URLs, API keys, EC2 IPs, Cloudflare account IDs, Worker routes, route tokens, or local `.env` files.
- Use `RPC_UPSTREAM_URL` as the only upstream input. Set it from an uncommitted `.env` file for Docker or from Cloudflare secrets for Worker deployments.
- Store both `RPC_UPSTREAM_URL` and `RPC_PROXY_PATH_TOKEN` as Cloudflare secrets. Do not put either value in Wrangler config.
- The nginx entrypoint rejects unsafe `RPC_UPSTREAM_URL` and `RPC_PROXY_LISTEN_PORT` values before rendering nginx config.
- nginx only accepts root path requests, rejects client query strings, and returns `404` for non-root paths so client input cannot alter a configured upstream path or query.
- nginx returns `204` for Cloudflare Containers health probes using `Host: ping` or `Host: containerstarthealthcheck` without forwarding to the upstream RPC provider.
- Worker-based routes use `/rpc/<route-token>`. The Worker layer strips forwarding, client-IP metadata, and sensitive client headers before forwarding. nginx clears accidental client `Authorization`, `Proxy-Authorization`, and `Cookie` headers before forwarding upstream.

## Local nginx Docker

Create an uncommitted `.env` from the placeholder template:

```bash
cp .env.example .env
```

Edit `.env` with deployment-specific values. Keep the placeholder shape in committed files:

```dotenv
RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
RPC_PROXY_LISTEN_PORT=8545
RPC_PROXY_PUBLISHED_PORT=8545
ETH_RPC_URL=http://127.0.0.1:8545
```

Run the local Docker deployment:

```bash
docker compose --env-file .env -f docker-compose.example.yml up --build -d
```

Check the proxy with a JSON-RPC request:

```bash
curl -X POST http://127.0.0.1:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Expected: the upstream provider returns a JSON-RPC response, typically with a hex `result` for `eth_blockNumber`.

## VM or EC2 nginx Docker

Build or copy the same Docker image to the host. Put runtime values in an uncommitted env file on the host:

```dotenv
RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
RPC_PROXY_LISTEN_PORT=8545
```

Example command shape:

```bash
docker run -d --name rpc-proxy \
  --env-file /path/to/uncommitted-rpc-proxy.env \
  -p 8545:8545 \
  --restart unless-stopped \
  rpc-proxy-nginx:local
```

Restrict inbound access to the published port with a VM firewall or cloud security group. Allowlist only trusted client source IPs, such as office, home, or VPN egress addresses. Do not expose the proxy port broadly.

Set local clients to the VM or EC2 endpoint:

```dotenv
ETH_RPC_URL=http://<vm-host-or-ip>:8545
```

## Cloudflare Worker Free

This path deploys `cloudflare/worker.mjs` and does not use Docker. For the first deploy, put both Cloudflare secrets in an uncommitted `.env.cloudflare.free` file:

```dotenv
RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
RPC_PROXY_PATH_TOKEN=<long-random-route-token>
```

Generate a route token for `RPC_PROXY_PATH_TOKEN`:

```bash
make rpc-proxy-path-token
```

Deploy once with the secrets file so both secrets are uploaded with the Worker version:

```bash
npx wrangler deploy --config wrangler.free.example.toml --secrets-file .env.cloudflare.free
```

The Wrangler config declares both secrets as required. Later deploys can use `npm run deploy:worker:free` after those secrets are configured. `wrangler secret put` is also valid for rotating an existing secret, but Cloudflare documents that it creates and deploys a new Worker version immediately.

Set local clients to the Worker route:

```dotenv
ETH_RPC_URL=https://<worker-domain>/rpc/<route-token>
```

The Worker validates the path token, rejects query strings, forwards matching requests to the configured upstream URL, preserves upstream status and body, returns generic `502` text for upstream fetch failures, and strips hop-by-hop, forwarding, client-IP metadata, and sensitive client headers.

Cloudflare documents Workers Free with a 100,000 requests per day limit and 10 ms CPU time per request. Cloudflare also documents that network wait time for `fetch()` calls does not count toward CPU time.

## Cloudflare Containers Paid

This path runs the nginx Docker image behind `cloudflare/container-worker.mjs` and a Container binding. It requires Workers Paid and Docker running locally because Wrangler builds and pushes the container image during deploy.

For the first deploy, put both Cloudflare secrets in an uncommitted `.env.cloudflare.containers` file:

```dotenv
RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
RPC_PROXY_PATH_TOKEN=<long-random-route-token>
```

Deploy once with the secrets file so both secrets are uploaded with the Worker version:

```bash
npx wrangler deploy --config wrangler.containers.example.toml --secrets-file .env.cloudflare.containers
```

The Wrangler config declares both secrets as required. Later deploys can use `npm run deploy:containers` after those secrets are configured. `wrangler secret put` is also valid for rotating an existing secret, but Cloudflare documents that it creates and deploys a new Worker version immediately.

Set local clients to the Containers-backed Worker route:

```dotenv
ETH_RPC_URL=https://<worker-domain>/rpc/<route-token>
```

The Containers Worker validates `/rpc/<route-token>`, rejects query strings before container startup, strips client-IP, forwarding, Cloudflare container routing, and sensitive client headers, then forwards the request to nginx at `/`.

## Verification

Run the full local verification suite before deploying or committing changes:

```bash
npm test
node --check cloudflare/container-worker.mjs
bash scripts/test-derive-upstream.sh
bash scripts/test-entrypoint.sh
docker build -t rpc-proxy-nginx:local .
bash scripts/test-nginx-routing.sh
```

Run Docker negative checks for unsafe config input:

```bash
unsafe_url_output="$(mktemp)"
unsafe_upstream='https://rpc-provider.invalid/v2/key?auth=$http_authorization'
if docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e "RPC_UPSTREAM_URL=$unsafe_upstream" rpc-proxy-nginx:local nginx -t >"$unsafe_url_output" 2>&1; then
  printf 'expected unsafe RPC_UPSTREAM_URL to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL contains characters that are unsafe for nginx configuration' "$unsafe_url_output"
rm -f "$unsafe_url_output"

invalid_upstream_port_output="$(mktemp)"
invalid_port_upstream='https://rpc-provider.invalid:99999/v2/key?api_key=placeholder'
if docker run --rm -e "RPC_UPSTREAM_URL=$invalid_port_upstream" rpc-proxy-nginx:local nginx -t >"$invalid_upstream_port_output" 2>&1; then
  printf 'expected invalid RPC_UPSTREAM_URL port to fail\n' >&2
  exit 1
fi
grep -F 'RPC_UPSTREAM_URL port must be a number from 1 to 65535' "$invalid_upstream_port_output"
if grep -F -q '/v2/key' "$invalid_upstream_port_output" || grep -F -q 'placeholder' "$invalid_upstream_port_output"; then
  printf 'invalid upstream port error leaked URL path or query\n' >&2
  exit 1
fi
rm -f "$invalid_upstream_port_output"

unsafe_port_output="$(mktemp)"
safe_upstream='https://rpc-provider.invalid/v2/key'
if docker run --rm --add-host rpc-provider.invalid:127.0.0.1 -e "RPC_UPSTREAM_URL=$safe_upstream" -e 'RPC_PROXY_LISTEN_PORT=8545; error_log /dev/stdout info' rpc-proxy-nginx:local nginx -t >"$unsafe_port_output" 2>&1; then
  printf 'expected unsafe RPC_PROXY_LISTEN_PORT to fail\n' >&2
  exit 1
fi
grep -F 'RPC_PROXY_LISTEN_PORT must be a number from 1 to 65535' "$unsafe_port_output"
rm -f "$unsafe_port_output"
```

Validate Cloudflare bundles without deploying:

```bash
npm run dry-run:worker:free
npm run dry-run:containers
```

Scan committed files for accidental concrete RPC values or route tokens. This snippet builds the regex in parts so `README.md` can be included in the scan target without matching the scan command itself:

```bash
secret_pattern='RPC_UPSTREAM_URL=https:'
secret_pattern="${secret_pattern}//"
secret_pattern="${secret_pattern}[^<]|RPC_PROXY_PATH_TOKEN"
secret_pattern="${secret_pattern}=[^<]|/v2/[A-Za-z0-9_-]{10,}"
rg -n "$secret_pattern" \
  .env.example Dockerfile Makefile docker docker-compose.example.yml cloudflare \
  wrangler.free.example.toml wrangler.containers.example.toml package.json README.md
```

Expected: no matches for real provider hosts, concrete upstream URLs, provider API keys, Cloudflare routes, or route tokens. Placeholder-only values such as `<rpc-provider-host>` and reserved test hosts such as `rpc-provider.invalid` are acceptable if a future scan pattern catches them intentionally.

Check whitespace before committing:

```bash
git diff --check
```

## References

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Containers getting started: https://developers.cloudflare.com/containers/get-started/
- Cloudflare Containers interface: https://developers.cloudflare.com/containers/container-class/
- Cloudflare Containers env vars and secrets: https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
