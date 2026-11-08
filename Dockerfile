# Builds HedgeDoc from this repository.
#
#   docker build -t hedgedoc .
#   docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t hedgedoc .
#
# Or straight from GitHub:
#
#   docker build -t hedgedoc https://github.com/<owner>/hedgedoc.git#<branch>
#
# The structure and the files in docker/ are taken from the official container build
# (https://github.com/hedgedoc/container), which clones the sources instead of using the checkout.
# Configure the container with CMD_* environment variables, see https://docs.hedgedoc.org/configuration/

ARG NODE_IMAGE=docker.io/library/node:24.22.1-trixie-slim@sha256:fdc9220097e0ae3bd947c44b10cd3af5867a67a6d3a23b30b30b70929219034e

# --- build the frontend ------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder

# Optional. HedgeDoc shows the commit it runs and links to the sources of this version (as AGPL
# requires). The .git directory is not part of the build context, so the commit can be passed in.
ARG GIT_COMMIT
# Optional. URL of the repository the sources are published at, if it is not the one in package.json.
ARG HEDGEDOC_REPOSITORY

# necessary on ARM because puppeteer doesn't provide a prebuilt binary
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV YARN_CACHE_FOLDER=/tmp/.yarn

RUN --mount=target=/var/lib/apt/lists,type=cache,sharing=locked \
    --mount=target=/var/cache/apt,type=cache,sharing=locked \
    apt-get update && \
    apt-get install --no-install-recommends -y git jq ca-certificates python-is-python3 build-essential

WORKDIR /hedgedoc

# Install the dependencies first, so that they are cached as long as the lock file does not change.
# Yarn itself is part of the repository (.yarn/releases).
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY .yarn/patches .yarn/patches
RUN --mount=type=cache,sharing=locked,target=/tmp/.yarn yarn install --immutable

COPY . .

RUN if [ -n "${GIT_COMMIT}" ]; then mkdir -p .git && echo "${GIT_COMMIT}" > .git/HEAD; fi
RUN if [ -n "${HEDGEDOC_REPOSITORY}" ]; then \
      jq ".repository.url = \"${HEDGEDOC_REPOSITORY}\"" package.json > package.new.json && \
      mv package.new.json package.json; \
    fi

RUN yarn run build

# --- install the dependencies needed at runtime ------------------------------------------------------
FROM ${NODE_IMAGE} AS modules-installer

WORKDIR /hedgedoc

ENV NODE_ENV=production
ENV YARN_CACHE_FOLDER=/tmp/.yarn

COPY --from=builder /hedgedoc /hedgedoc

RUN --mount=target=/var/lib/apt/lists,type=cache,sharing=locked \
    --mount=target=/var/cache/apt,type=cache,sharing=locked \
    rm /var/lib/dpkg/info/libc-bin.* && \
    apt-get update && \
    apt-get install --no-install-recommends -y git ca-certificates python-is-python3 build-essential

RUN --mount=type=cache,sharing=locked,target=/tmp/.yarn yarn workspaces focus --production

# --- the image that runs -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS app

LABEL org.opencontainers.image.title='HedgeDoc'
LABEL org.opencontainers.image.url='https://hedgedoc.org'
LABEL org.opencontainers.image.documentation='https://docs.hedgedoc.org/'
LABEL org.opencontainers.image.licenses='AGPL-3.0'

WORKDIR /hedgedoc

ARG UID=10000
ARG GID=10000
ENV NODE_ENV=production
ENV UPLOADS_MODE=0700

RUN apt-get update && \
    apt-get install --no-install-recommends -y gosu && \
    rm -r /var/lib/apt/lists/*

# Create hedgedoc user and group
RUN addgroup --gid $GID hedgedoc && \
    adduser --uid $UID --ingroup hedgedoc --home /hedgedoc/ --disabled-password --system hedgedoc

COPY --chown=$UID:$GID --from=modules-installer /hedgedoc /hedgedoc

# Configuration file, the actual configuration is done with environment variables
COPY ["docker/config.json", "/files/"]

# Healthcheck
COPY --chown=$UID:$GID docker/healthcheck.mjs /hedgedoc/healthcheck.mjs
HEALTHCHECK --interval=15s CMD node healthcheck.mjs

# For backwards compatibility
RUN ln -s /hedgedoc /codimd

# Symlink configuration files
RUN rm -f /hedgedoc/config.json
RUN ln -s /files/config.json /hedgedoc/config.json

EXPOSE 3000

COPY ["docker/docker-entrypoint.sh", "/usr/local/bin/docker-entrypoint.sh"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "app.js"]
