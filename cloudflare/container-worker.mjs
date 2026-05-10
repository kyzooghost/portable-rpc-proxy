import { HEADER_NAMES, PROXY_STRIPPED_REQUEST_HEADERS } from "./proxy-headers.mjs";

async function loadContainersPackage() {
  try {
    return await import("@cloudflare/containers");
  } catch (error) {
    if (globalThis.process?.versions?.node) {
      return {
        Container: class {},
        getContainer() {
          throw error;
        },
      };
    }

    throw error;
  }
}

const { Container, getContainer } = await loadContainersPackage();

const ENV_KEYS = Object.freeze({
  upstreamUrl: "RPC_UPSTREAM_URL",
  pathToken: "RPC_PROXY_PATH_TOKEN",
  containerBinding: "RPC_PROXY_CONTAINER",
  listenPort: "RPC_PROXY_LISTEN_PORT",
});

const CONTAINER = Object.freeze({
  defaultPort: 8545,
  instanceName: "rpc-proxy",
  listenPort: "8545",
  sleepAfter: "5m",
});

const ROUTE = Object.freeze({
  containerPath: "/",
  emptySearch: "",
  prefix: "/rpc/",
});

const HTTP_STATUS = Object.freeze({
  notFound: 404,
  configError: 500,
  badGateway: 502,
});

const RESPONSE_TEXT = Object.freeze({
  notFound: "Not found",
  missingUpstream: "Proxy upstream is not configured",
  missingPathToken: "Proxy path token is not configured",
  badGateway: "Bad gateway",
});

const STRIPPED_HEADERS = Object.freeze([
  HEADER_NAMES.authorization,
  HEADER_NAMES.cfContainerTargetPort,
  HEADER_NAMES.cookie,
  ...PROXY_STRIPPED_REQUEST_HEADERS,
]);

function getRequiredEnv(env, key) {
  const value = env?.[key];

  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function configError(message) {
  return new Response(message, { status: HTTP_STATUS.configError });
}

function expectedPath(pathToken) {
  return `${ROUTE.prefix}${pathToken}`;
}

function stripForwardHeaders(headers) {
  const connectionHeader = headers.get(HEADER_NAMES.connection);

  for (const headerName of STRIPPED_HEADERS) {
    headers.delete(headerName);
  }

  for (const headerName of connectionHeader?.split(",") ?? []) {
    const strippedHeaderName = headerName.trim().toLowerCase();

    if (strippedHeaderName.length > 0) {
      headers.delete(strippedHeaderName);
    }
  }
}

function buildContainerRequest(request) {
  const containerUrl = new URL(request.url);
  containerUrl.pathname = ROUTE.containerPath;
  containerUrl.search = ROUTE.emptySearch;

  const containerRequest = new Request(containerUrl.toString(), request);

  // nginx forwards client headers upstream, so sanitize before handing the request to the container.
  stripForwardHeaders(containerRequest.headers);

  return containerRequest;
}

export class RpcProxyContainer extends Container {
  defaultPort = CONTAINER.defaultPort;
  requiredPorts = [CONTAINER.defaultPort];
  sleepAfter = CONTAINER.sleepAfter;
}

export async function handleContainerRequest(request, env, dependencies = {}) {
  const { getContainerImpl = getContainer } = dependencies;
  const upstreamUrl = getRequiredEnv(env, ENV_KEYS.upstreamUrl);
  if (!upstreamUrl) {
    return configError(RESPONSE_TEXT.missingUpstream);
  }

  const pathToken = getRequiredEnv(env, ENV_KEYS.pathToken);
  if (!pathToken) {
    return configError(RESPONSE_TEXT.missingPathToken);
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== expectedPath(pathToken) || requestUrl.search !== ROUTE.emptySearch) {
    return new Response(RESPONSE_TEXT.notFound, { status: HTTP_STATUS.notFound });
  }

  const container = getContainerImpl(env[ENV_KEYS.containerBinding], CONTAINER.instanceName);

  try {
    await container.startAndWaitForPorts({
      startOptions: {
        envVars: {
          [ENV_KEYS.upstreamUrl]: upstreamUrl,
          [ENV_KEYS.listenPort]: CONTAINER.listenPort,
        },
      },
      ports: CONTAINER.defaultPort,
    });

    return await container.fetch(buildContainerRequest(request));
  } catch {
    return new Response(RESPONSE_TEXT.badGateway, { status: HTTP_STATUS.badGateway });
  }
}

export default {
  fetch: handleContainerRequest,
};
