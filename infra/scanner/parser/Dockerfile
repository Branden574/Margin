# Build from the official Node multi-architecture image; scanner execution never pulls.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl cmake g++ make pkg-config zlib1g-dev libjpeg62-turbo-dev libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --silent --show-error https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2.tar.gz -o qpdf.tar.gz && \
    echo '8a58af5b6141319287c1883bec8bd1bd545b7567b7fc5e6ce5d25a1c85f36397  qpdf.tar.gz' | sha256sum -c - && \
    tar -xzf qpdf.tar.gz && \
    cmake -S qpdf-12.4.2 -B qpdf-build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_DOC=OFF -DINSTALL_EXAMPLES=OFF -DREQUIRE_CRYPTO_OPENSSL=ON && \
    cmake --build qpdf-build --target libqpdf --parallel 2
COPY validate.cc qpdf-bounds.hh /build/
RUN g++ -std=c++20 -O2 -Wall -Wextra -I/build/qpdf-12.4.2/include -I/build/qpdf-12.4.2/libqpdf -I/build/qpdf-build/include \
    validate.cc qpdf-build/libqpdf/libqpdf.a -lz -ljpeg -lcrypto -o /build/validate
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
RUN apt-get update && apt-get install -y --no-install-recommends libjpeg62-turbo libssl3 zlib1g && rm -rf /var/lib/apt/lists/* && \
    mkdir /work /app && chown 65532:65532 /work
COPY --from=build /build/validate /app/validate
COPY --from=build /app /app
COPY --from=build /build/qpdf-12.4.2/NOTICE.md /app/licenses/qpdf-NOTICE.md
COPY --from=build /build/qpdf-12.4.2/LICENSE.txt /app/licenses/qpdf-LICENSE.txt
COPY runner.mjs /app/runner.mjs
LABEL com.margin.inspection.protocol="margin-pdf-inspection-v1" \
      com.margin.inspection.policy="qpdf-12.4.2+pdfjs-6.3.289+policy-1"
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["node", "--max-old-space-size=512", "/app/runner.mjs"]
