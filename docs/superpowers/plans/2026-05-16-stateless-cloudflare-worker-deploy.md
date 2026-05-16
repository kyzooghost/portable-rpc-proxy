# Stateless Cloudflare Worker Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stateless Make targets that deploy, delete, and inspect Cloudflare Worker Free RPC proxies from `RPC_UPSTREAM_URL`.

**Architecture:** A focused Node.js CLI script validates `RPC_UPSTREAM_URL`, derives a deterministic Worker name, creates a temporary JSON secrets file for Wrangler, invokes Wrangler, and prints the generated client RPC URL. The Makefile remains a thin command wrapper.

**Tech Stack:** Node.js built-in modules, Node test runner, Make, Wrangler `4.90.0`.

---

## File Structure

- Create `scripts/cloudflare-free-worker.mjs`: stateless deploy/delete/info CLI and exported pure helpers for tests.
- Create `scripts/cloudflare-free-worker.test.mjs`: unit tests for helper behavior and fake Wrangler command flows.
- Modify `Makefile`: add thin targets for deploy, delete, and info.
- Modify `package.json`: include `scripts/*.test.mjs` in the existing test command.
- Modify `.env.example`: document optional `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN` fallback.
- Modify `README.md`: document the stateless workflow and deletion path.

### Task 1: Failing Tests

**Files:**
- Create: `scripts/cloudflare-free-worker.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add tests before implementation**

Create Node tests that import `deriveWorkerName`, `deployWorker`, `deleteWorker`, and `infoWorker` from `scripts/cloudflare-free-worker.mjs`. Use fake Wrangler runners and deterministic token generators so tests do not touch Cloudflare or randomness.

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
npm test
```

Expected: fails because `scripts/cloudflare-free-worker.mjs` does not exist or does not export the tested functions yet.

### Task 2: Stateless CLI Implementation

**Files:**
- Create: `scripts/cloudflare-free-worker.mjs`

- [ ] **Step 1: Implement constants and validation**

Add constants for environment keys, commands, Wrangler arguments, URL validation messages, and output labels. Add validation that accepts only `http:` or `https:` upstream URLs with a DNS hostname and no userinfo or fragment.

- [ ] **Step 2: Implement deploy**

Derive `rpc-proxy-<8 hex chars>` from the exact upstream input, generate a 32-byte hex route token, write a temporary JSON secrets file with `RPC_UPSTREAM_URL` and `RPC_PROXY_PATH_TOKEN`, run `npx wrangler deploy --config wrangler.free.example.toml --name <worker-name> --secrets-file <tmpfile>`, replay Wrangler output to stderr, parse the workers.dev URL, and print only `ETH_RPC_URL=<url>/rpc/<token>` to stdout.

- [ ] **Step 3: Implement delete and info**

Delete derives the same Worker name and runs `npx wrangler delete <worker-name> --config wrangler.free.example.toml --force`. Info prints the derived Worker name and optional fallback workers.dev URL without printing the upstream URL.

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
npm test
```

Expected: all Node tests pass.

### Task 3: Makefile and Docs

**Files:**
- Modify: `Makefile`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add Make targets**

Add `cloudflare-free-deploy`, `cloudflare-free-delete`, and `cloudflare-free-info` targets that call the Node CLI with `RPC_UPSTREAM_URL` passed through the environment.

- [ ] **Step 2: Update templates and README**

Document `CLOUDFLARE_WORKERS_DEV_SUBDOMAIN` as an optional fallback only. Add examples for deploy, delete, and info. Update the secret-scan target list so `scripts` is scanned.

- [ ] **Step 3: Verify full change**

Run:

```bash
npm test
secret_pattern='RPC_UPSTREAM_URL=https:'
secret_pattern="${secret_pattern}//"
secret_pattern="${secret_pattern}[^<]|RPC_PROXY_PATH_TOKEN"
secret_pattern="${secret_pattern}=[^<]|/v2/[A-Za-z0-9_-]{10,}"
rg -n "$secret_pattern" .env.example Dockerfile Makefile docker docker-compose.example.yml cloudflare scripts wrangler.free.example.toml wrangler.containers.example.toml package.json README.md
```

Expected: tests pass and the scan does not find real upstream URLs, provider keys, or committed route tokens.
