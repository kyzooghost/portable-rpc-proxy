#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_KEYS = Object.freeze({
  upstreamUrl: "RPC_UPSTREAM_URL",
  pathToken: "RPC_PROXY_PATH_TOKEN",
  workersDevSubdomain: "CLOUDFLARE_WORKERS_DEV_SUBDOMAIN",
});

const COMMANDS = Object.freeze({
  deploy: "deploy",
  delete: "delete",
  info: "info",
});

const WRANGLER = Object.freeze({
  command: "npx",
  binary: "wrangler",
  config: "wrangler.free.example.toml",
});

const WORKER = Object.freeze({
  namePrefix: "rpc-proxy-",
  hashLength: 8,
  tokenBytes: 32,
  workersDevSuffix: ".workers.dev",
});

const OUTPUT_KEYS = Object.freeze({
  ethRpcUrl: "ETH_RPC_URL",
  workerName: "WORKER_NAME",
  workersDevUrl: "WORKERS_DEV_URL",
});

const HTTP_PROTOCOLS = Object.freeze({
  http: "http:",
  https: "https:",
});

const EXIT_CODES = Object.freeze({
  usage: 2,
  failure: 1,
});

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DNS_HOSTNAME_MAX_LENGTH = 253;
const WORKERS_DEV_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev(?:\/[^\s]*)?/gi;

class CliError extends Error {
  constructor(message, exitCode = EXIT_CODES.failure) {
    super(message);
    this.exitCode = exitCode;
  }
}

function isDnsHostname(hostname) {
  if (hostname.length === 0 || hostname.length > DNS_HOSTNAME_MAX_LENGTH) {
    return false;
  }

  return hostname.split(".").every((label) => DNS_LABEL_PATTERN.test(label));
}

function getRequiredUpstreamUrl(env) {
  const upstreamUrl = env?.[ENV_KEYS.upstreamUrl];

  if (typeof upstreamUrl !== "string" || upstreamUrl.length === 0) {
    throw new CliError(`${ENV_KEYS.upstreamUrl} is required`, EXIT_CODES.usage);
  }

  if (upstreamUrl.trim() !== upstreamUrl) {
    throw new CliError(`${ENV_KEYS.upstreamUrl} must not include leading or trailing whitespace`, EXIT_CODES.usage);
  }

  validateUpstreamUrl(upstreamUrl);
  return upstreamUrl;
}

function validateUpstreamUrl(upstreamUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(upstreamUrl);
  } catch {
    throw new CliError(`${ENV_KEYS.upstreamUrl} must be a valid URL`, EXIT_CODES.usage);
  }

  if (parsedUrl.protocol !== HTTP_PROTOCOLS.http && parsedUrl.protocol !== HTTP_PROTOCOLS.https) {
    throw new CliError(`${ENV_KEYS.upstreamUrl} must use http:// or https://`, EXIT_CODES.usage);
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new CliError(`${ENV_KEYS.upstreamUrl} must not include userinfo`, EXIT_CODES.usage);
  }

  if (parsedUrl.hash) {
    throw new CliError(`${ENV_KEYS.upstreamUrl} must not include a fragment`, EXIT_CODES.usage);
  }

  if (!isDnsHostname(parsedUrl.hostname)) {
    throw new CliError(`${ENV_KEYS.upstreamUrl} must include a DNS hostname`, EXIT_CODES.usage);
  }
}

export function deriveWorkerName(upstreamUrl) {
  const hashPrefix = createHash("sha256").update(upstreamUrl).digest("hex").slice(0, WORKER.hashLength);
  return `${WORKER.namePrefix}${hashPrefix}`;
}

function defaultGeneratePathToken() {
  return randomBytes(WORKER.tokenBytes).toString("hex");
}

function defaultRunWrangler(args) {
  const result = spawnSync(WRANGLER.command, [WRANGLER.binary, ...args], {
    encoding: "utf8",
  });

  if (result.error) {
    return {
      status: EXIT_CODES.failure,
      stdout: result.stdout ?? "",
      stderr: result.error.message,
    };
  }

  return {
    status: result.status ?? EXIT_CODES.failure,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeCommandOutput(result, stderr) {
  if (result.stdout) {
    stderr.write(result.stdout);
  }

  if (result.stderr) {
    stderr.write(result.stderr);
  }
}

function assertWranglerSucceeded(result, operation) {
  if (result.status !== 0) {
    throw new CliError(`Wrangler ${operation} failed`, result.status || EXIT_CODES.failure);
  }
}

async function writeSecretsFile(upstreamUrl, pathToken) {
  const tempDir = await mkdtemp(join(tmpdir(), "rpc-proxy-cloudflare-"));
  const secretsFilePath = join(tempDir, "secrets.json");
  const secrets = {
    [ENV_KEYS.upstreamUrl]: upstreamUrl,
    [ENV_KEYS.pathToken]: pathToken,
  };

  await writeFile(secretsFilePath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });

  return { tempDir, secretsFilePath };
}

export function findWorkersDevBaseUrl(output, workerName) {
  const matches = output.matchAll(WORKERS_DEV_URL_PATTERN);
  const expectedHostPrefix = `${workerName}.`;

  for (const match of matches) {
    const url = new URL(match[0]);
    const hostname = url.hostname.toLowerCase();

    if (hostname.startsWith(expectedHostPrefix) && hostname.endsWith(WORKER.workersDevSuffix)) {
      return url.origin;
    }
  }

  return undefined;
}

function getWorkersDevBaseUrlFromSubdomain(workerName, env) {
  const workersDevSubdomain = env?.[ENV_KEYS.workersDevSubdomain];

  if (typeof workersDevSubdomain !== "string" || workersDevSubdomain.length === 0) {
    return undefined;
  }

  if (
    workersDevSubdomain.trim() !== workersDevSubdomain ||
    workersDevSubdomain.includes("://") ||
    workersDevSubdomain.endsWith(WORKER.workersDevSuffix)
  ) {
    throw new CliError(
      `${ENV_KEYS.workersDevSubdomain} must be the workers.dev subdomain, not a full URL or host`,
      EXIT_CODES.usage,
    );
  }

  if (!isDnsHostname(workersDevSubdomain)) {
    throw new CliError(`${ENV_KEYS.workersDevSubdomain} must be a DNS subdomain`, EXIT_CODES.usage);
  }

  return `https://${workerName}.${workersDevSubdomain}${WORKER.workersDevSuffix}`;
}

function getPrintableWorkersDevBaseUrl(output, workerName, env) {
  return findWorkersDevBaseUrl(output, workerName) ?? getWorkersDevBaseUrlFromSubdomain(workerName, env);
}

export async function deployWorker({
  env = process.env,
  generatePathToken = defaultGeneratePathToken,
  runWrangler = defaultRunWrangler,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const upstreamUrl = getRequiredUpstreamUrl(env);
  const workerName = deriveWorkerName(upstreamUrl);
  const pathToken = generatePathToken();
  let tempDir;

  try {
    const secretsFile = await writeSecretsFile(upstreamUrl, pathToken);
    tempDir = secretsFile.tempDir;

    const wranglerArgs = [
      COMMANDS.deploy,
      "--config",
      WRANGLER.config,
      "--name",
      workerName,
      "--secrets-file",
      secretsFile.secretsFilePath,
    ];
    const result = runWrangler(wranglerArgs);
    writeCommandOutput(result, stderr);
    assertWranglerSucceeded(result, COMMANDS.deploy);

    const workersDevBaseUrl = getPrintableWorkersDevBaseUrl(`${result.stdout}\n${result.stderr}`, workerName, env);
    if (!workersDevBaseUrl) {
      throw new CliError(
        `Wrangler deploy succeeded, but the script could not determine the workers.dev URL. Set ${ENV_KEYS.workersDevSubdomain} and redeploy to print ${OUTPUT_KEYS.ethRpcUrl}.`,
      );
    }

    stdout.write(`${OUTPUT_KEYS.ethRpcUrl}=${workersDevBaseUrl}/rpc/${pathToken}\n`);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function deleteWorker({
  env = process.env,
  runWrangler = defaultRunWrangler,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const upstreamUrl = getRequiredUpstreamUrl(env);
  const workerName = deriveWorkerName(upstreamUrl);
  const wranglerArgs = [COMMANDS.delete, workerName, "--config", WRANGLER.config, "--force"];
  const result = runWrangler(wranglerArgs);

  writeCommandOutput(result, stderr);
  assertWranglerSucceeded(result, COMMANDS.delete);
  stdout.write(`Deleted Worker ${workerName}\n`);
}

export async function infoWorker({ env = process.env, stdout = process.stdout } = {}) {
  const upstreamUrl = getRequiredUpstreamUrl(env);
  const workerName = deriveWorkerName(upstreamUrl);
  const workersDevBaseUrl = getWorkersDevBaseUrlFromSubdomain(workerName, env);

  stdout.write(`${OUTPUT_KEYS.workerName}=${workerName}\n`);

  if (workersDevBaseUrl) {
    stdout.write(`${OUTPUT_KEYS.workersDevUrl}=${workersDevBaseUrl}\n`);
  }
}

function usage() {
  return `Usage: node scripts/cloudflare-free-worker.mjs <${COMMANDS.deploy}|${COMMANDS.delete}|${COMMANDS.info}>`;
}

async function main() {
  const command = process.argv[2];

  if (command === COMMANDS.deploy) {
    await deployWorker();
    return;
  }

  if (command === COMMANDS.delete) {
    await deleteWorker();
    return;
  }

  if (command === COMMANDS.info) {
    await infoWorker();
    return;
  }

  throw new CliError(usage(), EXIT_CODES.usage);
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || EXIT_CODES.failure;
  });
}
