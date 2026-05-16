RPC_PROXY_PATH_TOKEN_BYTES := 32
CLOUDFLARE_FREE_WORKER_SCRIPT := scripts/cloudflare-free-worker.mjs

.PHONY: rpc-proxy-path-token cloudflare-free-deploy cloudflare-free-delete cloudflare-free-info
rpc-proxy-path-token:
	@openssl rand -hex $(RPC_PROXY_PATH_TOKEN_BYTES)

cloudflare-free-deploy:
	@node $(CLOUDFLARE_FREE_WORKER_SCRIPT) deploy

cloudflare-free-delete:
	@node $(CLOUDFLARE_FREE_WORKER_SCRIPT) delete

cloudflare-free-info:
	@node $(CLOUDFLARE_FREE_WORKER_SCRIPT) info
