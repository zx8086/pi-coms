# deploy/hub/Dockerfile
#
# The coms-net hub. scripts/coms-net-server.ts is self-contained -- it imports
# nothing outside Bun's stdlib -- so there is no install step and no lockfile to
# copy. Bun runs the TypeScript directly.

FROM oven/bun:1.3-alpine

WORKDIR /app
COPY scripts/coms-net-server.ts ./scripts/coms-net-server.ts

# The mailbox lives under ~/.pi/coms-net (a named volume). Create it owned by
# bun before dropping privileges, or the volume mounts root-owned and sqlite
# cannot create messages.db.
RUN mkdir -p /home/bun/.pi/coms-net && chown -R bun:bun /home/bun/.pi

ENV PI_COMS_NET_HOST=0.0.0.0 \
    PI_COMS_NET_PORT=8787 \
    PI_COMS_NET_LOG_HEARTBEAT=0

EXPOSE 8787
USER bun
CMD ["bun", "scripts/coms-net-server.ts"]
