# Stateless Cloudflare Worker Deploy Design

## Goal

Add a repeatable stateless command path for deploying and deleting Cloudflare Worker Free RPC proxies from one required input:

```text
RPC_UPSTREAM_URL
```

The deploy command should derive all remaining deployment values, upload the Worker secrets, and print the client-facing proxy URL:

```text
https://<worker-name>.<workers-dev-subdomain>.workers.dev/rpc/<route-token>
```

The command must not print the full upstream URL, provider API key, or Cloudflare secret values.

## Non-Goals

- Do not add committed per-proxy config files.
- Do not store generated route tokens in the repository.
- Do not change Worker request forwarding behavior.
- Do not add Cloudflare Containers automation in this change.
- Do not require deleting Workers through the Cloudflare dashboard, though dashboard deletion remains valid for manual cleanup.

## Command Interface

The primary deploy command is:

```bash
make cloudflare-free-deploy RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
```

The primary delete command is:

```bash
make cloudflare-free-delete RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
```

The delete command derives the same Worker name from the same upstream URL, then runs Wrangler deletion for that Worker.

A separate info command should show non-secret derived values:

```bash
make cloudflare-free-info RPC_UPSTREAM_URL=https://<rpc-provider-host>/<provider-api-path>
```

The info command may print the derived Worker name and the expected workers.dev host. It must not print the upstream URL.

## Derived Values

The Worker name is deterministic:

```text
rpc-proxy-<8-char-sha256-prefix>
```

The hash input is the exact `RPC_UPSTREAM_URL` string supplied to the command. This keeps deploy and delete stateless while making names short enough for workers.dev DNS label limits.

The route token is generated fresh for each deploy using 32 random bytes encoded as lowercase hex. Redeploying the same upstream URL rotates the route token. The deploy command prints the new client-facing URL after a successful deploy.

The workers.dev base URL is extracted from Wrangler deploy output. `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN` may be used as a fallback if Wrangler output does not include a workers.dev URL, but it is not required for the normal deploy path.

## Implementation

Add a small shell script for stateless Cloudflare Worker Free operations. The script owns validation, derived names, temporary secret file creation, Wrangler invocation, and final output formatting. The Makefile provides thin targets around that script.

Expected script modes:

- `deploy`: validate `RPC_UPSTREAM_URL`, derive Worker name, generate `RPC_PROXY_PATH_TOKEN`, write a temporary `.env` secrets file, run `npx wrangler deploy cloudflare/worker.mjs --name <worker-name> --compatibility-date 2026-05-11 --secrets-file <tmpfile>`, then print the proxied URL.
- `delete`: validate `RPC_UPSTREAM_URL`, derive Worker name, then run `npx wrangler delete <worker-name>`.
- `info`: validate `RPC_UPSTREAM_URL`, derive Worker name, and print non-secret derived values.

Temporary secret files must be created with restrictive permissions and removed on exit.

## Error Handling

- Missing `RPC_UPSTREAM_URL` fails before invoking Wrangler.
- Invalid upstream URL fails before invoking Wrangler.
- Upstream URLs must use `http:` or `https:`, must include a DNS hostname, and must not include userinfo or fragments.
- If Wrangler deploy succeeds but the script cannot determine a workers.dev URL from Wrangler output or `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN`, the script fails with an actionable message and does not print the route token separately.
- Wrangler failures should propagate their exit code.
- Error messages must not include the full upstream URL, route token, or generated secrets file contents.

## Security

`RPC_UPSTREAM_URL` can contain a provider API key and must be treated as a secret. It is passed to Cloudflare only through Wrangler's secrets-file path. The route token is also a secret and is not committed or logged separately.

The only successful deploy output that includes a secret is the complete proxied RPC URL, because that URL is the intended client credential. The upstream URL must not be echoed.

## Verification

Add tests for the stateless script that verify:

- the Worker name is deterministic for the same upstream URL;
- the Worker name uses the `rpc-proxy-<8 hex chars>` format;
- deploy creates a temporary secrets file containing `RPC_UPSTREAM_URL` and `RPC_PROXY_PATH_TOKEN`;
- deploy invokes Wrangler with the derived Worker name and secrets file;
- deploy prints only the proxied URL after the fake Wrangler succeeds;
- delete invokes Wrangler for the same derived Worker name;
- invalid or missing upstream input fails before Wrangler is called;
- deploy derives the proxied URL from fake Wrangler output without requiring a second user input;
- `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN` can provide a fallback workers.dev URL when Wrangler output does not include one;
- output does not leak the full upstream URL.

Run the existing Cloudflare Worker tests too, because the deploy script depends on the same environment variable names and Worker route shape.
