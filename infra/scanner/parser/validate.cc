#include "qpdf-bounds.hh"
#include <qpdf/QPDFPageDocumentHelper.hh>
#include <iostream>
#include <set>

namespace {
const std::set<std::string> forbidden_keys = {
    "/A", "/AA", "/OpenAction", "/JS", "/JavaScript", "/XFA", "/EF", "/AF",
    "/EmbeddedFiles", "/URI", "/URL", "/RichMedia", "/RichMediaContent",
    "/RichMediaSettings", "/3DD", "/3DA", "/Movie", "/Sound", "/Launch",
    "/SubmitForm", "/ImportData", "/GoToR", "/GoToE", "/SpiderInfo", "/Collection",
    "/OPI", "/Alternates", "/Ref", "/FFilter", "/FDecodeParms",
};
const std::set<std::string> forbidden_types = {
    "/Action", "/Filespec", "/EmbeddedFile", "/RichMedia", "/Movie", "/Sound",
    "/Screen", "/3D", "/FileAttachment", "/Rendition", "/PS",
};
const std::set<std::string> allowed_filters = {
    "/FlateDecode", "/Fl", "/LZWDecode", "/LZW", "/ASCII85Decode", "/A85",
    "/ASCIIHexDecode", "/AHx", "/RunLengthDecode", "/RL", "/DCTDecode", "/DCT",
};
std::set<QPDFObjGen> visited;
size_t nodes{};
size_t image_pixels{};
std::set<QPDFObjGen> content_ids;
std::vector<QPDFObjectHandle> extra_contents;
void content(QPDFObjectHandle o) {
    if (o.isStream() && content_ids.insert(o.getObjGen()).second) extra_contents.push_back(o);
}
void image(QPDFObjectHandle dict) {
    auto w = dict.getKey("/Width"), h = dict.getKey("/Height");
    if (!w.isInteger() || !h.isInteger() || w.getIntValue() <= 0 || h.getIntValue() <= 0)
        throw Reject{"invalid_document"};
    const auto width = static_cast<size_t>(w.getIntValue());
    const auto height = static_cast<size_t>(h.getIntValue());
    constexpr size_t max_pixels = 16U * 1024 * 1024;
    if (width > max_pixels || height > max_pixels / width) throw Reject{"resource_limit"};
    const auto pixels = width * height;
    if (pixels > 64U * 1024 * 1024 - image_pixels) throw Reject{"resource_limit"};
    image_pixels += pixels;
    // Conservative RGBA expansion admission, independent of the filter-output work counter.
    budget(pixels * 4);
}
void walk(QPDFObjectHandle o, unsigned depth) {
    if (o.isIndirect() && !visited.insert(o.getObjGen()).second) return;
    if (++nodes > max_nodes || depth > max_depth) throw Reject{"resource_limit"};
    if (o.isStream()) {
        auto dict = o.getDict();
        if (dict.getKey("/Subtype").isNameAndEquals("/Image")) image(dict);
        if (dict.getKey("/Subtype").isNameAndEquals("/Form") ||
            dict.getKey("/PatternType").isInteger()) content(o);
        o = dict;
    }
    if (o.isArray()) {
        if (o.getArrayNItems() > 100000) throw Reject{"resource_limit"};
        for (auto item : o.aitems()) walk(item, depth + 1);
    } else if (o.isDictionary()) {
        for (auto [key, value] : o.ditems()) {
            if (value.isNull()) continue;
            if (forbidden_keys.contains(key)) throw Reject{"unsupported"};
            if ((key == "/Type" || key == "/Subtype") && value.isName() &&
                forbidden_types.contains(value.getName())) throw Reject{"unsupported"};
            // /F is also the integer annotation-flags field. Other forms name external files.
            if (key == "/F" && !value.isInteger()) throw Reject{"unsupported"};
            if (key == "/CharProcs" && value.isDictionary())
                for (auto [unused, glyph] : value.ditems()) content(glyph);
            walk(value, depth + 1);
        }
    }
}
class Contents final : public QPDFObjectHandle::ParserCallbacks {
    size_t tokens{};
public:
    void handleObject(QPDFObjectHandle o) override {
        if (++tokens > max_nodes) throw Reject{"resource_limit"};
        // Inline image filters would bypass the separately inspected stream dictionary.
        // Reject their parsed operators, including in forms, tiling patterns and Type3 glyphs.
        if (o.isInlineImage() || (o.isOperator() && o.getOperatorValue() == "BI"))
            throw Reject{"unsupported"};
    }
    void handleEOF() override {}
    void contentSize(size_t size) override {
        if (size > max_stream_decoded) throw Reject{"resource_limit"};
    }
};
void stream(QPDFObjectHandle o) {
    if (!o.isStream()) return;
    auto filter = o.getDict().getKey("/Filter");
    bool filtered = !filter.isNull();
    if (filtered) {
        if (filter.isName()) {
            if (!allowed_filters.contains(filter.getName())) throw Reject{"unsupported"};
        } else if (filter.isArray()) {
            if (filter.getArrayNItems() < 1 || filter.getArrayNItems() > 8)
                throw Reject{"resource_limit"};
            for (auto f : filter.aitems())
                if (!f.isName() || !allowed_filters.contains(f.getName()))
                    throw Reject{"unsupported"};
        } else throw Reject{"invalid_document"};
    }
    Sink sink(!filtered);
    bool attempted = false;
    const bool ok = o.pipeStreamData(&sink, &attempted, 0, qpdf_dl_all, true, false);
    if (exhausted || qpdf::global::limit_errors()) throw Reject{"resource_limit"};
    if (!ok || (filtered && !attempted)) throw Reject{"invalid_document"};
}
void result(const char* status, const char* reason, size_t pages = 0) {
    // All strings except the verified library version are constants; never print qpdf exceptions.
    std::cout << "{\"status\":\"" << status << "\",\"reason\":\"" << reason
        << "\",\"pageCount\":" << pages << ",\"qpdfVersion\":\""
        << QPDF::QPDFVersion() << "\"}\n";
}
}
int main() {
    try {
        limits();
        filters();
        auto quiet = std::make_shared<Sink>(false);
        auto logger = QPDFLogger::defaultLogger();
        logger->setInfo(quiet);
        logger->setWarn(quiet);
        logger->setError(quiet);
        QPDF pdf;
        pdf.setSuppressWarnings(true);
        pdf.setAttemptRecovery(false);
        pdf.processFile("/work/source.pdf");
        if (pdf.isEncrypted()) throw Reject{"unsupported"};
        if (pdf.getObjectCount() > max_objects) throw Reject{"resource_limit"};
        auto objects = pdf.getAllObjects();
        if (objects.size() > max_objects) throw Reject{"resource_limit"};
        walk(pdf.getTrailer(), 0);
        for (auto o : objects) walk(o, 0);
        for (auto o : objects) stream(o);
        auto pages = QPDFPageDocumentHelper(pdf).getAllPages();
        if (pages.empty()) throw Reject{"invalid_document"};
        if (pages.size() > 2000) throw Reject{"resource_limit"};
        Contents contents;
        for (auto page : pages) page.parsePageContents(&contents);
        for (auto o : extra_contents) o.parseAsContents(&contents);
        if (exhausted || qpdf::global::limit_errors())
            throw Reject{"resource_limit"};
        if (pdf.anyWarnings()) throw Reject{"invalid_document"};
        result("valid", "clean", pages.size());
        return 0;
    } catch (const Reject& r) {
        result("rejected", r.reason);
        return 10;
    } catch (const QPDFExc& e) {
        result("rejected", exhausted || qpdf::global::limit_errors() ? "resource_limit" :
            e.getErrorCode() == qpdf_e_password ? "unsupported" : "invalid_document");
        return 10;
    } catch (const std::bad_alloc&) {
        result("rejected", "resource_limit");
        return 10;
    } catch (...) {
        // Decoders can use std::runtime_error for corrupt streams; never expose exception text.
        result("rejected", exhausted || qpdf::global::limit_errors() ? "resource_limit" :
            "invalid_document");
        return 10;
    }
}
