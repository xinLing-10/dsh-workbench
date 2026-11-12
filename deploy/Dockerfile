ARG NODE_IMAGE=node:24.19.0-bookworm-slim
FROM ${NODE_IMAGE}
ARG DSH_VERSION=0.2.1-rc.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ tini curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.28.0 @deepseek-ai/dsh@${DSH_VERSION}
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY dsh-workbench/package.json dsh-workbench/package-lock.json /opt/workbench/dsh-workbench/
RUN npm ci --omit=dev --prefix /opt/workbench/dsh-workbench --no-audit --no-fund && npm cache clean --force
COPY dsh-workbench /opt/workbench/dsh-workbench
COPY spec-analyst-preset /opt/workbench/spec-analyst-preset
COPY stage-presets /opt/workbench/stage-presets
COPY deploy/entrypoint.sh /usr/local/bin/workbench-entrypoint
COPY deploy/healthcheck.mjs /usr/local/bin/workbench-healthcheck.mjs
RUN chmod -R a+rX /opt/workbench && chmod 755 /usr/local/bin/workbench-entrypoint && mkdir -p /workspace && chown node:node /workspace
USER node
ENV DSH_HOME=/home/node/.dsh
ENV NARB_NATIVE_CACHE_DIR=/home/node/.cache/dsh-native
WORKDIR /workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 CMD ["node", "/usr/local/bin/workbench-healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/workbench-entrypoint"]
