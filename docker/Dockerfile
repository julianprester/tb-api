# Thunderbird with tb-api REST API extension
# Based on jlesage/thunderbird
#
# The base image is pinned to a specific release tag (Thunderbird 151.0.1).
# Upgrading is a deliberate change: bump TB_IMAGE, run the integration checklist
# (Appendix B), then release. See README.md.

ARG TB_IMAGE=jlesage/thunderbird:v26.09.1

FROM ${TB_IMAGE}

# Copy the extension
COPY tb-api.xpi /opt/tb-api/tb-api.xpi

# Create distribution directory and policies.json for auto-installing the extension
# Thunderbird looks for policies in /usr/lib/thunderbird/distribution/
RUN mkdir -p /usr/lib/thunderbird/distribution/extensions

# Copy policies.json to auto-install the extension
COPY docker/policies.json /usr/lib/thunderbird/distribution/policies.json

# Copy the extension to the distribution extensions folder
# Using the extension ID from manifest.json
COPY tb-api.xpi /usr/lib/thunderbird/distribution/extensions/tb-api@julianprester.com.xpi

# Override startapp.sh to pass TB_API environment variables to Thunderbird
COPY docker/startapp.sh /startapp.sh
RUN chmod +x /startapp.sh

# Expose the API port in addition to the default ports (5800 for web, 5900 for VNC)
EXPOSE 9595
