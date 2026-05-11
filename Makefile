RPC_PROXY_PATH_TOKEN_BYTES := 32

.PHONY: rpc-proxy-path-token
rpc-proxy-path-token:
	@openssl rand -hex $(RPC_PROXY_PATH_TOKEN_BYTES)
