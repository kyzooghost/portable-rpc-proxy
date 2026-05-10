FROM nginx:1.27.5-alpine

COPY docker/derive-upstream.sh /usr/local/bin/derive-upstream.sh
COPY docker/docker-entrypoint.sh /usr/local/bin/rpc-proxy-entrypoint.sh
COPY docker/nginx.conf.template /etc/nginx/templates/nginx.conf.template

RUN chmod 0755 /usr/local/bin/derive-upstream.sh /usr/local/bin/rpc-proxy-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/rpc-proxy-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
