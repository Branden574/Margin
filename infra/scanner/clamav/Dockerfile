FROM clamav/clamav-debian@sha256:1b9f632fd2756d647ea76721c190f1a8821f3f1dc099b6b671e265d4346fcec4

LABEL com.margin.inspection.protocol="margin-av-inspection-v1" \
      com.margin.inspection.policy="clamav-1.4.6-policy-1"

# The official entrypoint starts networked daemons and changes mounted ownership.
# Neither behavior belongs in a per-document inspection container.
COPY --chmod=0555 scan.sh /opt/margin/scan.sh
COPY --chmod=0555 update.sh /opt/margin/update.sh
COPY --chmod=0444 freshclam.conf /opt/margin/freshclam.conf
USER 65532:65532
WORKDIR /work
HEALTHCHECK NONE
ENTRYPOINT ["/opt/margin/scan.sh"]
