import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { deleteWorker, deployWorker, deriveWorkerName, infoWorker } from "./cloudflare-free-worker.mjs";

const ENV_KEYS = Object.freeze({
  upstreamUrl: "RPC_UPSTREAM_URL",
  pathToken: "RPC_PROXY_PATH_TOKEN",
  workersDevSubdomain: "CLOUDFLARE_WORKERS_DEV_SUBDOMAIN",
});

const UPSTREAM_URL = "https://rpc-provider.invalid/v2/key";
const PATH_TOKEN = "a".repeat(64);
const WRANGLER_CONFIG = "wrangler.free.example.toml";

function captureStream() {
  const chunks = [];

  return {
    stream: {
      write(value) {
        chunks.push(String(value));
      },
    },
    text() {
      return chunks.join("");
    },
  };
}

function wranglerResult({ stdout = "", stderr = "", status = 0 } = {}) {
  return { stdout, stderr, status };
}

test("derives a stable short Worker name from the upstream URL", () => {
  const firstWorkerName = deriveWorkerName(UPSTREAM_URL);
  const secondWorkerName = deriveWorkerName(UPSTREAM_URL);

  assert.equal(firstWorkerName, secondWorkerName);
  assert.match(firstWorkerName, /^rpc-proxy-[0-9a-f]{8}$/);
});

test("deploy uploads secrets and prints only the proxied RPC URL", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const workerName = deriveWorkerName(UPSTREAM_URL);
  const workersDevUrl = `https://${workerName}.sandbox-worker.workers.dev`;
  const wranglerCalls = [];
  let secretsFilePath;

  await deployWorker({
    env: { [ENV_KEYS.upstreamUrl]: UPSTREAM_URL },
    generatePathToken: () => PATH_TOKEN,
    runWrangler(args) {
      wranglerCalls.push(args);
      secretsFilePath = args[args.indexOf("--secrets-file") + 1];

      const secrets = JSON.parse(readFileSync(secretsFilePath, "utf8"));
      assert.deepEqual(secrets, {
        [ENV_KEYS.upstreamUrl]: UPSTREAM_URL,
        [ENV_KEYS.pathToken]: PATH_TOKEN,
      });

      return wranglerResult({ stdout: `Deployed ${workersDevUrl}\n` });
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.deepEqual(wranglerCalls, [
    ["deploy", "--config", WRANGLER_CONFIG, "--name", workerName, "--secrets-file", secretsFilePath],
  ]);
  assert.equal(stdout.text(), `ETH_RPC_URL=${workersDevUrl}/rpc/${PATH_TOKEN}\n`);
  assert.equal(stdout.text().includes(UPSTREAM_URL), false);
  assert.equal(stderr.text().includes(UPSTREAM_URL), false);
  assert.equal(existsSync(secretsFilePath), false);
});

test("deploy uses the workers.dev subdomain fallback when Wrangler output has no URL", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const workerName = deriveWorkerName(UPSTREAM_URL);

  await deployWorker({
    env: {
      [ENV_KEYS.upstreamUrl]: UPSTREAM_URL,
      [ENV_KEYS.workersDevSubdomain]: "sandbox-worker",
    },
    generatePathToken: () => PATH_TOKEN,
    runWrangler() {
      return wranglerResult({ stdout: "Deployed Worker\n" });
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(stdout.text(), `ETH_RPC_URL=https://${workerName}.sandbox-worker.workers.dev/rpc/${PATH_TOKEN}\n`);
});

test("deploy does not print the route token separately when the workers.dev URL cannot be determined", async () => {
  const stdout = captureStream();
  const stderr = captureStream();

  await assert.rejects(
    () =>
      deployWorker({
        env: { [ENV_KEYS.upstreamUrl]: UPSTREAM_URL },
        generatePathToken: () => PATH_TOKEN,
        runWrangler() {
          return wranglerResult({ stdout: "Deployed Worker without URL\n" });
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    /could not determine the workers.dev URL/,
  );

  assert.equal(stdout.text().includes(PATH_TOKEN), false);
});

test("delete invokes Wrangler for the same derived Worker name", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const workerName = deriveWorkerName(UPSTREAM_URL);
  const wranglerCalls = [];

  await deleteWorker({
    env: { [ENV_KEYS.upstreamUrl]: UPSTREAM_URL },
    runWrangler(args) {
      wranglerCalls.push(args);
      return wranglerResult();
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.deepEqual(wranglerCalls, [["delete", workerName, "--config", WRANGLER_CONFIG, "--force"]]);
  assert.equal(stdout.text(), `Deleted Worker ${workerName}\n`);
  assert.equal(stdout.text().includes(UPSTREAM_URL), false);
});

test("deploy rejects invalid upstream input before invoking Wrangler", async () => {
  const cases = Object.freeze([
    ["missing upstream", {}, /RPC_UPSTREAM_URL is required/],
    ["invalid scheme", { [ENV_KEYS.upstreamUrl]: "ftp://rpc-provider.invalid/v2/key" }, /must use http:\/\/ or https:\/\//],
    ["userinfo", { [ENV_KEYS.upstreamUrl]: "https://user:pass@rpc-provider.invalid/v2/key" }, /must not include userinfo/],
    ["fragment", { [ENV_KEYS.upstreamUrl]: "https://rpc-provider.invalid/v2/key#frag" }, /must not include a fragment/],
  ]);

  for (const [label, env, messagePattern] of cases) {
    let wranglerCalled = false;

    await assert.rejects(
      () =>
        deployWorker({
          env,
          generatePathToken: () => PATH_TOKEN,
          runWrangler() {
            wranglerCalled = true;
            return wranglerResult();
          },
          stdout: captureStream().stream,
          stderr: captureStream().stream,
        }),
      messagePattern,
      label,
    );
    assert.equal(wranglerCalled, false, label);
  }
});

test("info prints derived values without printing the upstream URL", async () => {
  const stdout = captureStream();
  const workerName = deriveWorkerName(UPSTREAM_URL);

  await infoWorker({
    env: {
      [ENV_KEYS.upstreamUrl]: UPSTREAM_URL,
      [ENV_KEYS.workersDevSubdomain]: "sandbox-worker",
    },
    stdout: stdout.stream,
  });

  assert.equal(
    stdout.text(),
    `WORKER_NAME=${workerName}\nWORKERS_DEV_URL=https://${workerName}.sandbox-worker.workers.dev\n`,
  );
  assert.equal(stdout.text().includes(UPSTREAM_URL), false);
});
