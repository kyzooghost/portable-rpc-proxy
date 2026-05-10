import assert from "node:assert/strict";
import test from "node:test";

import { handleContainerRequest } from "./container-worker.mjs";

const ENV = Object.freeze({
  RPC_UPSTREAM_URL: "https://rpc-provider.invalid/v2/key",
  RPC_PROXY_PATH_TOKEN: "test-route-token",
  RPC_PROXY_CONTAINER: Object.freeze({ name: "binding" }),
});

function createContainerMock(response = new Response("container response")) {
  const calls = {
    fetchRequest: undefined,
    startOptions: undefined,
  };

  const container = {
    async fetch(request) {
      calls.fetchRequest = request;
      return response;
    },
    async startAndWaitForPorts(options) {
      calls.startOptions = options;
    },
  };

  return { calls, container };
}

test("rejects requests to the wrong path without starting a container", async () => {
  let getContainerCalled = false;
  const request = new Request("https://proxy.invalid/rpc/wrong-token", {
    method: "POST",
    body: "{}",
  });

  const response = await handleContainerRequest(request, ENV, {
    getContainerImpl() {
      getContainerCalled = true;
      throw new Error("unexpected container lookup");
    },
  });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal(getContainerCalled, false);
});

test("rejects requests with a query string without starting a container", async () => {
  let getContainerCalled = false;
  const request = new Request("https://proxy.invalid/rpc/test-route-token?client=1", {
    method: "POST",
    body: "{}",
  });

  const response = await handleContainerRequest(request, ENV, {
    getContainerImpl() {
      getContainerCalled = true;
      throw new Error("unexpected container lookup");
    },
  });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal(getContainerCalled, false);
});

test("returns config errors when required secrets are missing", async () => {
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    body: "{}",
  });

  const missingUpstreamResponse = await handleContainerRequest(
    request,
    { RPC_PROXY_PATH_TOKEN: "test-route-token" },
    {
      getContainerImpl() {
        throw new Error("unexpected container lookup");
      },
    },
  );
  const missingTokenResponse = await handleContainerRequest(
    request,
    { RPC_UPSTREAM_URL: ENV.RPC_UPSTREAM_URL },
    {
      getContainerImpl() {
        throw new Error("unexpected container lookup");
      },
    },
  );

  assert.equal(missingUpstreamResponse.status, 500);
  assert.equal(await missingUpstreamResponse.text(), "Proxy upstream is not configured");
  assert.equal(missingTokenResponse.status, 500);
  assert.equal(await missingTokenResponse.text(), "Proxy path token is not configured");
});

test("starts the named container and forwards the request to the container root", async () => {
  const body = '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}';
  const { calls, container } = createContainerMock();
  let containerBinding;
  let containerName;
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });

  const response = await handleContainerRequest(request, ENV, {
    getContainerImpl(binding, name) {
      containerBinding = binding;
      containerName = name;
      return container;
    },
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "container response");
  assert.equal(containerBinding, ENV.RPC_PROXY_CONTAINER);
  assert.equal(containerName, "rpc-proxy");
  assert.deepEqual(calls.startOptions, {
    startOptions: {
      envVars: {
        RPC_UPSTREAM_URL: ENV.RPC_UPSTREAM_URL,
        RPC_PROXY_LISTEN_PORT: "8545",
      },
    },
    ports: 8545,
  });
  assert.equal(calls.fetchRequest.url, "https://proxy.invalid/");
  assert.equal(calls.fetchRequest.method, "POST");
  assert.equal(calls.fetchRequest.headers.get("content-type"), "application/json");
  assert.equal(await calls.fetchRequest.text(), body);
});

test("strips client and forwarding metadata before forwarding to the container", async () => {
  const strippedHeaders = Object.freeze([
    ["authorization", "Bearer client-token"],
    ["cf-connecting-ip", "198.51.100.10"],
    ["cf-connecting-ipv6", "2001:db8::1"],
    ["cf-container-target-port", "1234"],
    ["cf-ipcountry", "US"],
    ["cf-pseudo-ipv4", "198.51.100.11"],
    ["cf-ray", "ray-id"],
    ["cf-visitor", '{"scheme":"https"}'],
    ["connection", "x-custom-hop, upgrade"],
    ["content-length", "2"],
    ["cookie", "session=client-secret"],
    ["forwarded", "for=198.51.100.10"],
    ["host", "client.invalid"],
    ["keep-alive", "timeout=5"],
    ["proxy-authenticate", "Basic realm"],
    ["proxy-authorization", "Basic client-secret"],
    ["te", "trailers"],
    ["trailer", "x-trailer"],
    ["transfer-encoding", "chunked"],
    ["true-client-ip", "198.51.100.10"],
    ["upgrade", "websocket"],
    ["via", "1.1 proxy"],
    ["x-client-ip", "198.51.100.10"],
    ["x-cluster-client-ip", "198.51.100.10"],
    ["x-custom-hop", "remove-me"],
    ["x-forwarded-for", "198.51.100.10"],
    ["x-forwarded-host", "client.invalid"],
    ["x-forwarded-port", "443"],
    ["x-forwarded-proto", "https"],
    ["x-forwarded-server", "edge.invalid"],
    ["x-real-ip", "198.51.100.10"],
  ]);
  const { calls, container } = createContainerMock();
  const request = new Request("https://proxy.invalid/rpc/test-route-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(strippedHeaders),
    },
    body: "{}",
  });

  const response = await handleContainerRequest(request, ENV, {
    getContainerImpl() {
      return container;
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.fetchRequest.headers.get("content-type"), "application/json");
  for (const [headerName] of strippedHeaders) {
    assert.equal(calls.fetchRequest.headers.has(headerName), false, `${headerName} should not be forwarded`);
  }
});
