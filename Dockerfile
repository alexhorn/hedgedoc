# Builds HedgeDoc from this repository.
#
#   docker build -t hedgedoc .
#   docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t hedgedoc .
#
# Or straight from GitHub:
#
#   docker build -t hedgedoc https://github.com/<owner>/hedgedoc.git#<branch>
#
# The stages are ordered and split by what they depend on, so that Docker's build cache can be used:
#
#   deps-build      development dependencies   depend on package.json and yarn.lock only
#   deps-prod       production dependencies    depend on package.json and yarn.lock only
#   frontend        webpack build              depends on the frontend sources and the above
#   app             the image that runs        the backend sources are copied last, changing
#                                              those does not rebuild anything expensive
#
# Changing a backend file (lib/, app.js, ...) rebuilds only the last stage. Changing a frontend
# file rebuilds the frontend and the last stage. Dependencies are only installed again when the
# lock file changes.
#
# HedgeDoc links to the sources of the version it runs. When running a fork, set CMD_SOURCE_URL at
# runtime (for example https://github.com/<owner>/hedgedoc/tree/<branch>), no rebuild is needed.
#
# The helper files in docker/ are taken from the official container build
# (https://github.com/hedgedoc/container). Configure the container with CMD_* environment
# variables, see https://docs.hedgedoc.org/configuration/

ARG NODE_IMAGE=docker.io/library/node:24.22.1-trixie-slim@sha256:fdc9220097e0ae3bd947c44b10cd3af5867a67a6d3a23b30b30b70929219034e

# --- development dependencies, needed to build the frontend ------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS deps-build

# necessary on ARM because puppeteer doesn't provide a prebuilt binary
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV YARN_CACHE_FOLDER=/tmp/.yarn

RUN --mount=target=/var/lib/apt/lists,type=cache,sharing=locked \
    --mount=target=/var/cache/apt,type=cache,sharing=locked \
    apt-get update && \
    apt-get install --no-install-recommends -y git ca-certificates python-is-python3 build-essential

WORKDIR /hedgedoc

# Yarn itself is part of the repository (.yarn/releases)
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY .yarn/patches .yarn/patches
RUN --mount=type=cache,sharing=locked,target=/tmp/.yarn yarn install --immutable

# --- the frontend ------------------------------------------------------------------------------------
FROM deps-build AS frontend

# Only what webpack reads. Backend files are not copied here, so they cannot invalidate this stage.
COPY .babelrc webpack.common.js webpack.dev.js webpack.prod.js webpack.htmlexport.js ./
COPY locales locales
COPY public public

RUN yarn run build

# --- production dependencies -------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps-prod

WORKDIR /hedgedoc

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV YARN_CACHE_FOLDER=/tmp/.yarn

RUN --mount=target=/var/lib/apt/lists,type=cache,sharing=locked \
    --mount=target=/var/cache/apt,type=cache,sharing=locked \
    rm /var/lib/dpkg/info/libc-bin.* && \
    apt-get update && \
    apt-get install --no-install-recommends -y git ca-certificates python-is-python3 build-essential

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY .yarn/patches .yarn/patches
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

# For backwards compatibility
RUN ln -s /hedgedoc /codimd

# Helper files. They rarely change, so they come before the sources.
COPY ["docker/config.json", "/files/"]
COPY ["docker/docker-entrypoint.sh", "/usr/local/bin/docker-entrypoint.sh"]
COPY --chown=$UID:$GID docker/healthcheck.mjs /hedgedoc/healthcheck.mjs

# The dependencies change with the lock file only
COPY --chown=$UID:$GID --from=deps-prod /hedgedoc/node_modules /hedgedoc/node_modules

# The output of the frontend build. It changes with the frontend sources only, so it is copied
# before the sources, to keep this (large) layer when only the backend changes.
COPY --chown=$UID:$GID --from=frontend /hedgedoc/public/build /hedgedoc/public/build
COPY --chown=$UID:$GID --from=frontend /hedgedoc/public/views/build /hedgedoc/public/views/build

# The sources. This is the layer that changes with (almost) every commit, but it is only a copy.
# The context does not contain node_modules or the build output (see .dockerignore), so it adds to
# the directories above instead of replacing them.
COPY --chown=$UID:$GID . /hedgedoc

# Symlink configuration files
RUN rm -f /hedgedoc/config.json
RUN ln -s /files/config.json /hedgedoc/config.json

# Optional. HedgeDoc shows the commit it runs. The .git directory is not part of the build context,
# so the commit can be passed in. This comes last because it changes with every commit.
ARG GIT_COMMIT
RUN if [ -n "${GIT_COMMIT}" ]; then mkdir -p /hedgedoc/.git && echo "${GIT_COMMIT}" > /hedgedoc/.git/HEAD; fi

HEALTHCHECK --interval=15s CMD node healthcheck.mjs

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "app.js"]
