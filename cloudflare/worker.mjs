import { HEADER_NAMES, PROXY_STRIPPED_REQUEST_HEADERS } from "./proxy-headers.mjs";

const ENV_KEYS = Object.freeze({
  upstreamUrl: "RPC_UPSTREAM_URL",
  pathToken: "RPC_PROXY_PATH_TOKEN",
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
  invalidUpstream: "Proxy upstream URL is invalid",
  badGateway: "Bad gateway",
});

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

const ROUTE = Object.freeze({
  emptySearch: "",
  searchPrefix: "?",
  searchSeparator: "&",
});

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DNS_HOSTNAME_MAX_LENGTH = 253;

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

function isDnsHostname(hostname) {
  if (hostname.length > DNS_HOSTNAME_MAX_LENGTH) {
    return false;
  }

  return hostname.split(".").every((label) => DNS_LABEL_PATTERN.test(label));
}

function validateUpstreamUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }

  if (url.username || url.password || url.hash) {
    return undefined;
  }

  if (!isDnsHostname(url.hostname)) {
    return undefined;
  }

  return url.toString();
}

function expectedPath(pathToken) {
  return `/rpc/${pathToken}`;
}

function copyForwardHeaders(headers) {
  const forwardedHeaders = new Headers(headers);
  const connectionHeader = headers.get(HEADER_NAMES.connection);

  for (const headerName of PROXY_STRIPPED_REQUEST_HEADERS) {
    forwardedHeaders.delete(headerName);
  }

  for (const headerName of connectionHeader?.split(",") ?? []) {
    const strippedHeaderName = headerName.trim().toLowerCase();

    if (strippedHeaderName.length > 0) {
      forwardedHeaders.delete(strippedHeaderName);
    }
  }

  return forwardedHeaders;
}

function appendRequestSearch(upstreamUrl, requestSearch) {
  if (requestSearch === ROUTE.emptySearch) {
    return upstreamUrl;
  }

  const upstream = new URL(upstreamUrl);
  const clientQuery = requestSearch.startsWith(ROUTE.searchPrefix) ? requestSearch.slice(1) : requestSearch;

  if (clientQuery.length === 0) {
    return upstreamUrl;
  }

  const separator = upstream.search === ROUTE.emptySearch ? ROUTE.searchPrefix : ROUTE.searchSeparator;
  return `${upstreamUrl}${separator}${clientQuery}`;
}

export async function buildUpstreamRequest(request, upstreamUrl, requestSearch = ROUTE.emptySearch) {
  const init = {
    method: request.method,
    headers: copyForwardHeaders(request.headers),
    redirect: "manual",
  };

  if (!BODYLESS_METHODS.has(request.method)) {
    init.body = await request.arrayBuffer();
  }

  return new Request(appendRequestSearch(upstreamUrl, requestSearch), init);
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const upstreamValue = getRequiredEnv(env, ENV_KEYS.upstreamUrl);
  if (!upstreamValue) {
    return configError(RESPONSE_TEXT.missingUpstream);
  }

  const pathToken = getRequiredEnv(env, ENV_KEYS.pathToken);
  if (!pathToken) {
    return configError(RESPONSE_TEXT.missingPathToken);
  }

  const upstreamUrl = validateUpstreamUrl(upstreamValue);
  if (!upstreamUrl) {
    return configError(RESPONSE_TEXT.invalidUpstream);
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== expectedPath(pathToken)) {
    return new Response(RESPONSE_TEXT.notFound, { status: HTTP_STATUS.notFound });
  }

  try {
    const upstreamRequest = await buildUpstreamRequest(request, upstreamUrl, requestUrl.search);
    return await fetchImpl(upstreamRequest);
  } catch {
    return new Response(RESPONSE_TEXT.badGateway, { status: HTTP_STATUS.badGateway });
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
