# TEST ONLY. Intentionally blocked until provenance.json is reviewed and completed.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NODE_IMAGE
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /work
COPY rehearsal ./rehearsal
RUN chown root:node /work/rehearsal/entrypoint.sh \
    && chmod 0640 /work/rehearsal/entrypoint.sh
RUN node rehearsal/verify-provenance.cjs --base "$NODE_IMAGE" \
    && npm pack pnpm@11.9.0 --pack-destination /tmp \
    && node rehearsal/verify-provenance.cjs --tarball /tmp/pnpm-11.9.0.tgz \
    && npm install --global /tmp/pnpm-11.9.0.tgz
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/unreachable pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.worker.json ./
COPY src ./src
COPY scripts/github-worker.ts ./scripts/github-worker.ts
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/unreachable pnpm db:generate \
    && node node_modules/typescript/bin/tsc -p rehearsal/tsconfig.json \
    && mkdir -p /opt/devflow-rehearsal /evidence /admission/data /admission/evidence \
    && printf '%s\n' '{"version":1,"root":"/work","nodeMajor":22}' > /opt/devflow-rehearsal/image.json \
    && chown node:node /evidence
ENV HOME=/tmp
USER node
ENTRYPOINT ["/bin/sh", "/work/rehearsal/entrypoint.sh"]
CMD ["serve"]
