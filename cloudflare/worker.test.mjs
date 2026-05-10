import assert from "node:assert/strict";
import test from "node:test";

import worker, { handleRequest } from "./worker.mjs";

const ENV = Object.freeze({
  RPC_UPSTREAM_URL: "https://rpc-provider.invalid/v2/key",
  RPC_PROXY_PATH_TOKEN: "test-route-token",
});

test("rejects requests to the wrong path without forwarding", async () => {
  let fetchCalled = false;
  const request = new Request("https://proxy.invalid/rpc/wrong-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleRequest(request, ENV, async () => {
    fetchCalled = true;
    return new Response("unexpected");
  });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal(fetchCalled, false);
});

test("forwards POST body to configured upstream URL", async () => {
  const body = '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}';
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.10",
    },
    body,
  });

  let forwardedRequest;
  const response = await handleRequest(request, ENV, async (upstreamRequest) => {
    forwardedRequest = upstreamRequest;
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(forwardedRequest.url, ENV.RPC_UPSTREAM_URL);
  assert.equal(forwardedRequest.method, "POST");
  assert.equal(forwardedRequest.headers.get("content-type"), "application/json");
  assert.equal(forwardedRequest.headers.has("x-forwarded-for"), false);
  assert.equal(await forwardedRequest.text(), body);
});

test("strips hop-by-hop and IP-identifying headers from forwarded requests", async () => {
  const strippedHeaders = Object.freeze([
    ["connection", "x-custom-hop, upgrade"],
    ["x-custom-hop", "remove-me"],
    ["upgrade", "websocket"],
    ["forwarded", "for=198.51.100.10"],
    ["true-client-ip", "198.51.100.10"],
    ["cf-connecting-ipv6", "2001:db8::1"],
    ["cf-pseudo-ipv4", "198.51.100.11"],
    ["x-forwarded-for", "198.51.100.10"],
    ["x-real-ip", "198.51.100.10"],
    ["cf-connecting-ip", "198.51.100.10"],
  ]);
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(strippedHeaders),
    },
    body: "{}",
  });

  let forwardedRequest;
  const response = await handleRequest(request, ENV, async (upstreamRequest) => {
    forwardedRequest = upstreamRequest;
    return new Response("upstream response");
  });

  assert.equal(response.status, 200);
  assert.equal(forwardedRequest.headers.get("content-type"), "application/json");
  for (const [headerName] of strippedHeaders) {
    assert.equal(forwardedRequest.headers.has(headerName), false, `${headerName} should not be forwarded`);
  }
});

test("forwards GET without adding a request body", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "GET",
  });

  let forwardedRequest;
  const response = await handleRequest(request, ENV, async (upstreamRequest) => {
    forwardedRequest = upstreamRequest;
    return new Response("upstream get response", { status: 400 });
  });

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "upstream get response");
  assert.equal(forwardedRequest.method, "GET");
  assert.equal(forwardedRequest.body, null);
});

test("returns config error when upstream is missing", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleRequest(
    request,
    { RPC_PROXY_PATH_TOKEN: "test-route-token" },
    async () => new Response("unexpected"),
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Proxy upstream is not configured");
});

test("returns bad gateway when upstream fetch throws", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleRequest(request, ENV, async () => {
    throw new Error("network failed");
  });

  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Bad gateway");
});

test("default Worker fetch ignores the execution context argument", async () => {
  const originalFetch = globalThis.fetch;
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    body: "{}",
  });
  const executionContext = Object.freeze({
    waitUntil() {},
  });

  let forwardedRequest;

  try {
    globalThis.fetch = async (upstreamRequest) => {
      forwardedRequest = upstreamRequest;
      return new Response("default fetch response", { status: 200 });
    };

    const response = await worker.fetch(request, ENV, executionContext);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "default fetch response");
    assert.equal(forwardedRequest.url, ENV.RPC_UPSTREAM_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
