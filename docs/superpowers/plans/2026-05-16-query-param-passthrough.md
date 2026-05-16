# Query Param Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward proxy request query parameters to the upstream RPC URL across Cloudflare Worker Free, Cloudflare Containers, and nginx Docker deployments.

**Architecture:** Remove query rejection after path-token validation. Worker Free appends the raw client query string to the upstream URL. Containers Worker preserves the client query string when rewriting the request to nginx root. nginx appends runtime `$args` using a generated `?` or `&` separator so client input is not rendered into config.

**Tech Stack:** Node.js built-in test runner, Cloudflare Worker modules, POSIX shell, nginx template rendering, Docker routing test.

---

## Files

- Modify `cloudflare/worker.test.mjs` and `cloudflare/worker.mjs`.
- Modify `cloudflare/container-worker.test.mjs` and `cloudflare/container-worker.mjs`.
- Modify `docker/derive-upstream.sh`, `docker/docker-entrypoint.sh`, `docker/nginx.conf.template`, `scripts/test-entrypoint.sh`, and `scripts/test-nginx-routing.sh`.
- Modify `README.md`.

## Steps

- [ ] Write failing Worker Free test that verifies `?client=1&client=2` is appended to an upstream URL that already has `?existing=1`.
- [ ] Write failing Containers Worker test that verifies `?client=1&client=2` is forwarded to nginx root.
- [ ] Write failing nginx routing test that verifies client query args are appended after configured upstream query args.
- [ ] Implement Worker Free query append helper and remove query rejection.
- [ ] Implement Containers Worker query preservation and remove query rejection.
- [ ] Add `RPC_CLIENT_QUERY_SEPARATOR` derivation for nginx and render an nginx `map` that appends runtime `$args`.
- [ ] Update README statements that currently say client query strings are rejected.
- [ ] Run `npm test`.
- [ ] Run shell tests for upstream derivation and entrypoint rendering.
- [ ] Run Docker nginx routing test if Docker is available.
- [ ] Run secret scan over committed targets.
