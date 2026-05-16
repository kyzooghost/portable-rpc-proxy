# Query Param Passthrough Design

## Goal

Allow clients to call a proxy URL with query parameters and forward those parameters to the configured upstream RPC URL across all deployment paths:

```text
<proxy-url>?queryParam=A
```

If `RPC_UPSTREAM_URL` already contains query parameters, client query parameters are appended after the configured upstream parameters:

```text
https://rpc-provider.invalid/v2/key?existing=1&queryParam=A
```

## Scope

- Cloudflare Worker Free must allow query strings on `/rpc/<route-token>`.
- Cloudflare Containers Worker must allow query strings on `/rpc/<route-token>` and forward them to nginx at `/`.
- nginx Docker must allow query strings on `/` and append them to the configured upstream URL.
- Path validation stays unchanged. Wrong paths still return `404` and are not forwarded.
- Duplicate query parameters are preserved in order.
- Query parameters are appended, not merged or overwritten.

## Security

The route token remains part of the path and is still required before any forwarding occurs. Query parameters are client input, so they must not be written into generated nginx config. nginx should append runtime `$args` to a static configured upstream URL using a generated separator.

Logs must not include `RPC_UPSTREAM_URL`, route tokens, or request bodies. Tests may use reserved `.invalid` hostnames and placeholder values only.

## Verification

- Worker Free test proves `?client=1&client=2` reaches the upstream URL.
- Containers Worker test proves the same query is forwarded to nginx at `/`.
- nginx routing test proves `/ ?client=1&client=2` reaches `RPC_UPSTREAM_URL` with configured upstream query parameters first.
- Existing wrong-path, header stripping, and config error tests continue to pass.
