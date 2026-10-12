# Isolated PDF inspection engine, policy 1

This image performs real structural PDF validation and computes every page's effective PDF.js viewport. It is one stage of source inspection. Malware decisions belong to the separately isolated ClamAV stage; this image alone never approves an upload for the application.

## Build and test

```sh
docker build --tag margin-pdf-parser:policy-1 infra/scanner/parser
MARGIN_PDF_PARSER_IMAGE=margin-pdf-parser:policy-1 npx vitest run tests/scanner-parser.docker.test.ts --silent=false
```

The build uses the official, digest-pinned Node 22 Debian image, checksum-verified qpdf 12.4.2 source, the committed exact npm lock for PDF.js 6.3.289, and Debian libraries. Package updates produce a new image identity; the runtime must select the reviewed immutable local image ID and verify its configuration before starting it. It must never pull during document inspection. The test suite creates and removes only its own randomly named containers and uses generated or attributed upstream fixtures. It skips unless an image is explicitly selected.

## Wire contract

The fixed entrypoint is `node --max-old-space-size=512 /app/runner.mjs`, with no additional arguments. Input is raw PDF bytes on stdin, at most 100 MiB, written exclusively to `/work/source.pdf` with mode 0600. The runner uses no client filename, path, URL or JSON parameter.

Output is exactly one newline-terminated JSON object, at most 262144 bytes, containing only these fixed fields:

```json
{
  "protocol": "margin-pdf-inspection-v1",
  "engine": "qpdf-pdfjs",
  "engineVersion": "qpdf-12.4.2+pdfjs-6.3.289+policy-1",
  "status": "valid",
  "reason": "clean",
  "pageCount": 1,
  "pageGeometry": [{ "index": 0, "width": 612, "height": 792 }]
}
```

A rejection uses `status: "rejected"`, `pageCount: 0`, omits `pageGeometry`, and has one of `unsupported`, `invalid_document`, or `resource_limit` as its reason. Exit 0 is required for valid output; exit 10 is required for a rejection. Unknown engine/filesystem failures exit 20 without approval. The supervisor must treat resource limits, signals, timeout, OOM, invalid protocol, nonempty diagnostics, or unsuccessful cleanup as unavailable/quarantined, never clean. It must wait for the exit and prove the owned container stopped and was removed; a JSON result alone is insufficient.

The exact image labels are `com.margin.inspection.protocol=margin-pdf-inspection-v1` and `com.margin.inspection.policy=qpdf-12.4.2+pdfjs-6.3.289+policy-1`. Both engine versions are checked against actual loaded libraries before success. Image user is `65532:65532`, workdir `/work`, no Cmd or declared volumes. Its only inherited environment is the official base image's PATH, NODE_VERSION=22.23.1, YARN_VERSION=1.22.22.

## Parser boundaries

- qpdf recovery is disabled; warnings, damaged structure, encryption, unsupported filters, actions, JavaScript, XFA, external URI/file references, embedded files and rich media are refused through parsed objects. Ordinary text containing those names remains text. Internal destination links remain supported; all action dictionaries and external links are refused in this initial policy.
- Registered qpdf filter adapters are installed **before** `processFile`, covering internal xref and compressed-object streams as well as normal streams. The only six decoding factories in pinned qpdf 12.4.2 are wrapped: Flate, LZW, ASCII85, ASCIIHex, RunLength and DCT, including aliases. Its remaining built-in Crypt identity filter is replaced by a rejecting factory. Unknown factories cannot decode. JBIG2, JPX, CCITT and inline images are deliberately unsupported until their independent resource accounting is implemented. Parsed inline-image operators are also refused in forms, tiling patterns and Type3 glyph streams.
- The structural pass admits at most 100000 objects, 500000 traversal nodes and content tokens, depth 64, eight filters per stream, 2000 pages and 64 MiB per filter output. The shared 256 MiB work budget counts filter outputs, intermediate filter-chain outputs, unfiltered streams in the validation pass, and conservative RGBA image expansion. For TIFF/PNG predictors, 3× final output conservatively covers both pre- and post-predictor output: TIFF preserves length and PNG removes one byte per nonempty row; qpdf pads partial final rows. Its separate per-stage limits remain active. This budget is intentionally conservative, and repeated decoding is charged again.
- Image dictionary dimensions are limited to 16 Mi pixels per image and 64 Mi pixels in total. DCT input has an independent 64 MiB bound. A libjpeg public `jpeg_read_header` check verifies actual JPEG SOF dimensions before decoding and applies the same separate pixel limits and RGBA charge, so a small PDF dictionary cannot hide a large JPEG. Full qpdf DCT decoding then validates the image data. Inline images and other image decoders cannot bypass this accounting.
- The tiny delegate adapter uses private headers from the exact pinned qpdf source release with its static library. No upstream source is patched. Changes to qpdf require reviewing its factory inventory, pipeline behavior and fixtures before updating the version.
- PDF.js is a second parser, using `stopAtErrors`, disabled XFA/system fonts/font faces/native image decoding/offscreen canvas, bundled CMaps/fonts/WASM, and no network. `isEvalSupported: false` is also supplied; PDF.js 6.3.289 no longer declares that older option, so its presence is not relied upon as a security boundary. The PDF scripting runtime is never instantiated. Every page runs `getOperatorList` and `getViewport({scale:1})`, preserving CropBox, rotation and UserUnit, with at most 500000 aggregate operators and finite positive dimensions at most 100000. Geometry contains zero-based indices and no document text.

The 256 MiB counter describes qpdf structural-pass work and conservative image admission, **not** total process memory, the independent PDF.js pass, font/graphics execution cost, or all upstream parser allocations. A hostile parser path can hit the independent container memory/deadline limit before returning JSON. Those outcomes must remain quarantined. Validation is a deliberately restrictive supported PDF subset, not proof that every conforming PDF will be accepted or that either engine is vulnerability-free.

## Required host sandbox

The supervisor must enforce and verify a read-only root, no network, numeric nonroot user, dropped capabilities, no-new-privileges, no mounts except owned noexec/nosuid/nodev tmpfs, no credentials or Docker socket, one CPU, 1 GiB memory with no extra Linux swap, 64 PIDs, no core dumps, and a bounded deadline/output collector. Tests use 128 MiB `/work` and 16 MiB `/tmp`. The image itself does not establish these runtime settings. tmpfs does not establish zero physical persistence on a swapping macOS/Docker VM host.

## Evidence and dependencies

Actual ARM64 engine fixtures cover benign text, Flate/JPEG images, effective rotated/cropped UserUnit geometry, 500 pages, active/escaped objects, links, attachments, XFA, encryption, malformed bytes, hidden inline images, unsupported internal decoders, nesting/filter/page/image limits, a JPEG header/dictionary mismatch, aggregate stream inflation, compressed object tables and predictor intermediate work. Timings are local fixture observations including container start, not production throughput or 100000-user capacity evidence. See the test output for measurements from the selected image.

Primary references: [qpdf API](https://qpdf.readthedocs.io/en/stable/library.html), [pinned qpdf stream factories](https://github.com/qpdf/qpdf/blob/v12.4.2/libqpdf/QPDF_Stream.cc), [pinned predictor implementation](https://github.com/qpdf/qpdf/blob/v12.4.2/libqpdf/Pl_PNGFilter.cc), [libjpeg public API](https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/main/doc/libjpeg.txt), [PDF.js API source](https://github.com/mozilla/pdf.js/blob/v6.3.289/src/display/api.js). qpdf and PDF.js are Apache-2.0; qpdf notices are copied into the image, npm dependency notices remain alongside their packages, and Debian library notices remain in `/usr/share/doc`. Redistribution should preserve these and the base image's dependency notices. The encrypted fixture has its own attribution and license in `fixtures/`.
