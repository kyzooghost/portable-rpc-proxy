import assert from "node:assert/strict";
import test from "node:test";

import { HEADER_NAMES } from "./proxy-headers.mjs";
import worker, { handleRequest } from "./worker.mjs";

const ENV = Object.freeze({
  RPC_UPSTREAM_URL: "https://rpc-provider.invalid/v2/key",
  RPC_PROXY_PATH_TOKEN: "test-route-token",
});

const INVALID_UPSTREAM_RESPONSE_TEXT = "Proxy upstream URL is invalid";

const INVALID_UPSTREAM_URL_CASES = Object.freeze([
  ["invalid scheme", "ftp://rpc-provider.invalid/v2/key"],
  ["userinfo", "https://user:pass@rpc-provider.invalid/v2/key"],
  ["fragment", "https://rpc-provider.invalid/v2/key#frag"],
  ["IPv6 literal", "https://[2001:db8::1]/v2/key"],
  ["underscore DNS label", "https://_bad.invalid/v2/key"],
  ["leading hyphen DNS label", "https://-bad.invalid/v2/key"],
  ["trailing hyphen DNS label", "https://bad-.invalid/v2/key"],
  ["empty DNS label", "https://bad..invalid/v2/key"],
]);

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

test("rejects requests with a query string without forwarding", async () => {
  let fetchCalled = false;
  const request = new Request("https://proxy.invalid/rpc/test-route-token?client=1", {
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

test("strips client Authorization and Cookie headers from forwarded requests", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      [HEADER_NAMES.authorization]: "Bearer client-token",
      [HEADER_NAMES.cookie]: "session=client-secret",
      "content-type": "application/json",
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
  assert.equal(forwardedRequest.headers.has(HEADER_NAMES.authorization), false);
  assert.equal(forwardedRequest.headers.has(HEADER_NAMES.cookie), false);
});

test("strips hop-by-hop and IP-identifying headers from forwarded requests", async () => {
  const strippedHeaders = Object.freeze([
    ["connection", "x-custom-hop, upgrade"],
    ["x-custom-hop", "remove-me"],
    ["upgrade", "websocket"],
    ["forwarded", "for=198.51.100.10"],
    ["via", "1.1 proxy"],
    ["true-client-ip", "198.51.100.10"],
    ["cf-connecting-ipv6", "2001:db8::1"],
    ["cf-pseudo-ipv4", "198.51.100.11"],
    ["x-client-ip", "198.51.100.10"],
    ["x-cluster-client-ip", "198.51.100.10"],
    ["x-forwarded-for", "198.51.100.10"],
    ["x-forwarded-host", "client.invalid"],
    ["x-forwarded-port", "443"],
    ["x-forwarded-proto", "https"],
    ["x-forwarded-server", "edge.invalid"],
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

test("forwards requests with empty Connection header tokens", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      connection: "x-custom-hop, ",
      "x-custom-hop": "remove-me",
    },
    body: "{}",
  });

  let forwardedRequest;
  const response = await handleRequest(request, ENV, async (upstreamRequest) => {
    forwardedRequest = upstreamRequest;
    return new Response("upstream response");
  });

  assert.notEqual(response.status, 502);
  assert.equal(response.status, 200);
  assert.equal(forwardedRequest.headers.has("x-custom-hop"), false);
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

test("returns config error for invalid upstream URLs without forwarding", async () => {
  for (const [label, upstreamUrl] of INVALID_UPSTREAM_URL_CASES) {
    let fetchCalled = false;
    const request = new Request("https://proxy.invalid/rpc/test-route-token", {
      method: "POST",
      body: "{}",
    });

    const response = await handleRequest(
      request,
      { ...ENV, RPC_UPSTREAM_URL: upstreamUrl },
      async () => {
        fetchCalled = true;
        return new Response("unexpected");
      },
    );

    assert.equal(response.status, 500, label);
    assert.equal(await response.text(), INVALID_UPSTREAM_RESPONSE_TEXT, label);
    assert.equal(fetchCalled, false, label);
  }
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
