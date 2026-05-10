# RPC Proxy Deployment Design

## Goal

Provide flexible deployment options for a minimal JSON-RPC proxy without committing any concrete upstream RPC URL, API key, EC2 address, Cloudflare account value, route token, or other sensitive deployment-specific value.

The proxy exists to route local CLI and script traffic through infrastructure that can reach the upstream RPC provider when the local corporate proxy blocks direct outbound HTTPS to provider API subdomains.

## Non-Goals

- Do not commit a specific provider URL or API key.
- Do not require EC2 as the only deployment target.
- Do not require Cloudflare as the only deployment target.
- Do not require HTTP headers for client authentication, because some JSON-RPC tools only accept an RPC URL.
- Do not add request caching or JSON-RPC method filtering in the baseline proxy.

## Deployment Paths

### Path 1: nginx Docker on EC2 or Any VM

This path keeps nginx Docker as the portable container option. EC2 is one supported deployment target, but the same container can run on any Docker-capable host.

The container uses an nginx configuration template rendered from runtime configuration. The upstream RPC endpoint is supplied as one deployment-time environment variable or through an uncommitted env file.

Expected runtime inputs:

- `RPC_UPSTREAM_URL`: full upstream provider URL, including any provider API key path segment.
- `RPC_PROXY_LISTEN_PORT`: local container listen port, usually `8545`.

The container startup script derives nginx internals such as upstream scheme, host, and path from `RPC_UPSTREAM_URL`. Those derived values are not user-facing configuration.

Security is primarily enforced outside the container with a VM firewall or cloud security group. Inbound access should be restricted to known client IPs. Public `0.0.0.0/0` exposure is out of scope for the safe baseline.

### Path 2: Cloudflare Worker on Free

This path is the lightweight Cloudflare option and does not run nginx. A Worker receives HTTP requests, validates a secret URL path token, forwards the request to the configured upstream RPC URL with `fetch()`, and returns the upstream response.

This path is expected to fit personal CLI and planner usage on Cloudflare Workers Free unless request volume exceeds 100,000 Worker requests per UTC day. Cloudflare documents Workers Free as 100,000 requests per day and 10 ms CPU time per invocation. Cloudflare also documents that network wait time for `fetch()` does not count as CPU time.

Expected runtime inputs:

- `RPC_UPSTREAM_URL`: full upstream provider URL, stored as a Cloudflare secret because it can include a provider API key path segment.
- `RPC_PROXY_PATH_TOKEN`: random route token stored as a Cloudflare secret because it is the Worker access-control credential.

These Cloudflare values must not be placed in plain-text Wrangler configuration.

Client-facing URL shape:

```text
https://<worker-domain>/rpc/<route-token>
```

The route token is embedded in `ETH_RPC_URL` for tools that cannot send custom headers.

### Path 3: Cloudflare Containers on Paid

This path is the Cloudflare Docker option. It runs the nginx container behind a Cloudflare Worker and Container binding.

Cloudflare's current Containers documentation describes Docker image deployment through Wrangler and marks Containers as available on Workers Paid. This path should be treated as paid-only unless Cloudflare changes the product limits.

The Worker validates the same secret URL path token before forwarding requests to the container. The nginx container receives the same `RPC_UPSTREAM_URL` runtime configuration used by the EC2 or VM path.

## Data Flow

1. A local CLI, script, or planner reads `ETH_RPC_URL`.
2. The client sends HTTP traffic to the selected proxy endpoint.
3. The proxy forwards the request to the configured upstream RPC endpoint.
4. The proxy preserves the upstream status and response body.
5. The local client sees the proxy endpoint as its RPC URL and does not need direct corporate-network access to the upstream provider host.

For nginx, HTTPS upstream forwarding must support both TLS SNI and the HTTP `Host` header:

- `proxy_ssl_server_name on;` enables SNI during the TLS handshake.
- `proxy_set_header Host <upstream-host>;` sets the HTTP host after TLS is established.

The committed nginx template must derive the upstream host from `RPC_UPSTREAM_URL` at container startup rather than hardcoding a provider host.

## Access Control

### VM or EC2

Restrict inbound access at the network layer using a firewall or security group. Only known office, home, or VPN IPs should be allowed to reach the proxy listen port.

### Cloudflare Worker and Cloudflare Containers

Use a secret path token as the baseline access control mechanism:

```text
/rpc/<route-token>
```

Requests to any other path return `404` or `401` and are not forwarded upstream.

A shared secret header can be supported later for clients that can send headers, but it is not required in the baseline because some JSON-RPC tools only accept a URL.

## Error Handling

- Missing upstream configuration returns a clear proxy configuration error and does not attempt forwarding.
- Invalid upstream configuration returns a clear proxy configuration error and does not print sensitive values.
- Requests to the wrong Cloudflare path return `404` or `401`.
- Upstream network errors return `502 Bad Gateway` with a generic message.
- Upstream provider errors pass through so clients can see the provider's JSON-RPC error.
- `GET` requests are forwarded like any other method; the upstream may return its own error.
- Logs must not include the full upstream URL, API key, route token, or RPC request bodies.

## Committed Artifacts

The design allows these committed files:

- `nginx.conf.template` with placeholders only.
- `.env.example` with variable names and placeholder values only.
- `docker-compose.example.yml` or a runbook command with placeholders only.
- `worker.example.ts` for the Cloudflare Free Worker proxy, reading values from environment bindings.
- `wrangler.example.toml` with placeholder names only.
- Documentation explaining EC2 or VM Docker, Cloudflare Worker Free, and Cloudflare Containers Paid deployment paths.

The design forbids committing:

- Real upstream RPC URLs.
- Provider API keys.
- EC2 public IPs or hostnames.
- Cloudflare account IDs, worker routes, or route tokens.
- Local `.env` files containing deploy-time secrets.

## Verification

Each deployment path should be checked with equivalent behavior tests:

- `GET` to the proxy is allowed and forwarded to upstream, even if the upstream returns its own error.
- `POST` to the wrong Cloudflare path returns `404` or `401`.
- `POST` to the correct Cloudflare path forwards to the upstream.
- `eth_blockNumber` returns a JSON-RPC response with a hex `result`.
- Upstream provider errors pass through instead of being replaced by generic proxy errors.
- Proxy logs do not print the full upstream URL, API key, route token, or RPC request body.
- Committed files contain placeholders only.

For nginx, verification must confirm that `proxy_ssl_server_name on;` is present and that the upstream `Host` header is derived from `RPC_UPSTREAM_URL`.

For Cloudflare Worker Free, request volume should be monitored. If usage approaches 100,000 requests per UTC day, move to the VM/nginx path or upgrade the Cloudflare deployment.

## Current Source Assumptions

- Cloudflare Workers Free supports 100,000 requests per day and 10 ms CPU time per invocation.
- Cloudflare documents that network wait time for `fetch()` does not count as Worker CPU time.
- Cloudflare Containers are deployed through Wrangler and require Workers Paid.

These assumptions were checked against Cloudflare documentation on 2026-05-11 and should be re-verified before deploying if Cloudflare product limits have changed.
