#pragma once
#include <qpdf/QPDF.hh>
#include <qpdf/QPDFLogger.hh>
#include <qpdf/QPDFStreamFilter.hh>
#include <qpdf/global.hh>
// Private delegate headers from the checksum-pinned qpdf 12.4.2 source only.
// No upstream source is patched. Registration uses the public filter API before processFile.
#include <qpdf/SF_ASCII85Decode.hh>
#include <qpdf/SF_ASCIIHexDecode.hh>
#include <qpdf/SF_DCTDecode.hh>
#include <qpdf/SF_FlateLzwDecode.hh>
#include <qpdf/SF_RunLengthDecode.hh>
#include <memory>
#include <stdexcept>
#include <csetjmp>
#include <cstdio>
#include <jpeglib.h>

namespace {
constexpr size_t max_decoded = 256U * 1024 * 1024;
constexpr size_t max_stream_decoded = 64U * 1024 * 1024;
constexpr size_t max_objects = 100000;
constexpr size_t max_nodes = 500000;
constexpr unsigned max_depth = 64;
size_t decoded{};
bool exhausted{};
struct Reject { const char* reason; };
void budget(size_t bytes) {
    if (bytes > max_decoded - decoded) {
        exhausted = true;
        throw Reject{"resource_limit"};
    }
    decoded += bytes;
}
size_t jpeg_pixels{};
struct JpegError {
    jpeg_error_mgr manager;
    std::jmp_buf jump;
};
void jpeg_error(j_common_ptr info) {
    auto* error = reinterpret_cast<JpegError*>(info->err);
    std::longjmp(error->jump, 1);
}
void jpeg_message(j_common_ptr info, int level) {
    if (level < 0) jpeg_error(info);
}
void jpeg_output(j_common_ptr) {}
// Read actual JPEG SOF dimensions before qpdf's decoder allocates image buffers.
// The PDF dictionary can lie about Width/Height. Header parsing uses libjpeg's
// public API, with no document-derived diagnostics or image decompression here.
void jpeg_header(std::string const& bytes) {
    auto info = std::make_unique<jpeg_decompress_struct>();
    auto error = std::make_unique<JpegError>();
    info->err = jpeg_std_error(&error->manager);
    error->manager.error_exit = jpeg_error;
    error->manager.emit_message = jpeg_message;
    error->manager.output_message = jpeg_output;
    if (setjmp(error->jump)) {
        jpeg_destroy_decompress(info.get());
        throw Reject{"invalid_document"};
    }
    jpeg_create_decompress(info.get());
    info->mem->max_memory_to_use = max_stream_decoded;
    jpeg_mem_src(info.get(), reinterpret_cast<unsigned char const*>(bytes.data()), bytes.size());
    const int header = jpeg_read_header(info.get(), true);
    const size_t width = info->image_width, height = info->image_height;
    const int components = info->num_components, precision = info->data_precision;
    jpeg_destroy_decompress(info.get());
    if (header != JPEG_HEADER_OK || !width || !height) throw Reject{"invalid_document"};
    if (precision != 8 || (components != 1 && components != 3 && components != 4))
        throw Reject{"unsupported"};
    constexpr size_t max_pixels = 16U * 1024 * 1024;
    if (width > max_pixels || height > max_pixels / width) throw Reject{"resource_limit"};
    const size_t pixels = width * height;
    if (pixels > 64U * 1024 * 1024 - jpeg_pixels) throw Reject{"resource_limit"};
    jpeg_pixels += pixels;
    budget(pixels * 4);
}
class JpegGuard final : public Pipeline {
    std::string bytes;
    bool done{};
public:
    explicit JpegGuard(Pipeline* next) : Pipeline("jpeg-header-admission", next) {}
    void write(unsigned char const* data, size_t len) override {
        if (len > max_stream_decoded - bytes.size()) {
            exhausted = true;
            throw Reject{"resource_limit"};
        }
        bytes.append(reinterpret_cast<char const*>(data), len);
    }
    void finish() override {
        if (done) return;
        done = true;
        jpeg_header(bytes);
        getNext()->write(reinterpret_cast<unsigned char const*>(bytes.data()), bytes.size());
        getNext()->finish();
        bytes.clear();
    }
};
class Sink final : public Pipeline {
    bool count;
public:
    explicit Sink(bool count) : Pipeline("bounded-discard", nullptr), count(count) {}
    void write(unsigned char const*, size_t len) override { if (count) budget(len); }
    void finish() override {}
};
class Count final : public Pipeline {
    size_t seen{};
    size_t multiplier;
public:
    explicit Count(Pipeline* next, size_t multiplier = 1) :
        Pipeline("bounded-filter", next), multiplier(multiplier) {}
    void write(unsigned char const* data, size_t len) override {
        if (len > max_stream_decoded - seen) {
            exhausted = true;
            throw Reject{"resource_limit"};
        }
        // TIFF preserves size. PNG removes one byte per nonempty output row,
        // so its pre-predictor + post-predictor output is at most 3x output.
        // qpdf pads partial final rows. Charge conservatively for both stages
        // without patching or accessing the delegate's internal pipeline chain.
        budget(len * multiplier);
        seen += len;
        getNext()->write(data, len);
    }
    void finish() override { getNext()->finish(); }
};
class Filter final : public QPDFStreamFilter {
    std::shared_ptr<QPDFStreamFilter> delegate;
    std::unique_ptr<Count> counter;
    std::unique_ptr<JpegGuard> jpeg;
    bool is_jpeg;
    size_t multiplier{1};
public:
    explicit Filter(std::shared_ptr<QPDFStreamFilter> f, bool is_jpeg = false) :
        delegate(std::move(f)), is_jpeg(is_jpeg) {}
    bool setDecodeParms(QPDFObjectHandle p) override {
        if (p.isDictionary()) {
            auto predictor = p.getKey("/Predictor");
            if (predictor.isInteger() && predictor.getIntValue() > 1) multiplier = 3;
        }
        return delegate->setDecodeParms(p);
    }
    Pipeline* getDecodePipeline(Pipeline* next) override {
        counter = std::make_unique<Count>(next, multiplier);
        auto pipeline = delegate->getDecodePipeline(counter.get());
        if (!is_jpeg) return pipeline;
        jpeg = std::make_unique<JpegGuard>(pipeline);
        return jpeg.get();
    }
    bool isSpecializedCompression() override { return delegate->isSpecializedCompression(); }
    bool isLossyCompression() override { return delegate->isLossyCompression(); }
};
void filters() {
    using Factory = std::function<std::shared_ptr<QPDFStreamFilter>()>;
    const std::pair<const char*, Factory> factories[] = {
        {"/FlateDecode", SF_FlateLzwDecode::flate_factory},
        {"/LZWDecode", SF_FlateLzwDecode::lzw_factory},
        {"/ASCII85Decode", SF_ASCII85Decode::factory},
        {"/ASCIIHexDecode", SF_ASCIIHexDecode::factory},
        {"/RunLengthDecode", SF_RunLengthDecode::factory},
        {"/DCTDecode", SF_DCTDecode::factory},
    };
    for (const auto& [name, factory] : factories) {
        const bool jpeg = std::string(name) == "/DCTDecode";
        QPDF::registerStreamFilter(name, [factory, jpeg] {
            return std::make_shared<Filter>(factory(), jpeg);
        });
    }
    // qpdf 12.4.2 has exactly one other built-in factory: the /Crypt identity
    // filter. Unknown names have no factory and fail decoding. Refuse Crypt even
    // during xref/object-stream parsing, before our later dictionary walk.
    QPDF::registerStreamFilter("/Crypt", []() -> std::shared_ptr<QPDFStreamFilter> {
        throw Reject{"unsupported"};
    });
}
void limits() {
    using namespace qpdf::global;
    limits::doc_max_warnings(1);
    limits::parser_max_nesting(max_depth);
    limits::parser_max_errors(1);
    limits::parser_max_container_size(100000);
    limits::parser_max_container_size_damaged(100000);
    limits::max_stream_filters(8);
    limits::flate_max_memory(max_stream_decoded);
    limits::png_max_memory(max_stream_decoded);
    limits::tiff_max_memory(max_stream_decoded);
    limits::run_length_max_memory(max_stream_decoded);
    limits::dct_max_memory(max_stream_decoded);
    limits::dct_max_progressive_scans(100);
    options::dct_throw_on_corrupt_data(true);
}
}
