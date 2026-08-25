FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Official Fleet install, scoped to this image (not the host).
RUN npm install -g @apralabs/apra-fleet \
  && apra-fleet install --skill none

WORKDIR /workspace

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "workflows/boilerplate/main.mjs"]
