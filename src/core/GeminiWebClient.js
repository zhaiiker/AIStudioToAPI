/**
 * File: src/core/GeminiWebClient.js
 * Description: Gemini Web API client - payload construction, stream frame parsing,
 *              image storage. Ported from gemini2api/app/core/gemini_client.py.
 *
 * NOTE: This module does NOT make HTTP requests directly. All actual HTTP calls
 * are executed via BrowserManager.executeGeminiWebRequest() (Playwright page.evaluate)
 * to bypass Google's TLS-fingerprint/bot-detection.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── URLs ──────────────────────────────────────────────────────────────────────
const GENERATE_URL =
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";

// ─── Model header key ─────────────────────────────────────────────────────────
const MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb";

// ─── Model registry ───────────────────────────────────────────────────────────
// IDs from Gemini web x-goog-ext-525001261-jspb header, mirroring gemini2api GEMINI_MODELS
const GEMINI_WEB_MODELS = {
    // === Free basic tier (capacity: 1) ===
    "gemini-web/gemini-3.1-pro": { id: "9d8ca3786ebdfbea", capacity: 1, family: "pro" },
    "gemini-web/gemini-3.6-flash": { id: "fbb127bbb056c959", capacity: 1, family: "flash" },
    "gemini-web/gemini-3.6-flash-thinking": { id: "5bf011840784117a", capacity: 1, family: "flash-thinking" },
    // === Advanced subscription tier (capacity: 2) ===
    "gemini-web/gemini-3.1-pro-advanced": { id: "e6fa609c3fa255c0", capacity: 2, family: "pro" },
    "gemini-web/gemini-3.6-flash-advanced": { id: "56fdd199312815e2", capacity: 2, family: "flash" },
    "gemini-web/gemini-3.6-flash-thinking-advanced": { id: "e051ce1aa80aa576", capacity: 2, family: "flash-thinking" },
    // === Plus subscription tier (capacity: 4) ===
    "gemini-web/gemini-3.1-pro-plus": { id: "e6fa609c3fa255c0", capacity: 4, family: "pro" },
    "gemini-web/gemini-3.6-flash-plus": { id: "56fdd199312815e2", capacity: 4, family: "flash" },
    "gemini-web/gemini-3.6-flash-thinking-plus": { id: "e051ce1aa80aa576", capacity: 4, family: "flash-thinking" },
};

// ─── Alias map ────────────────────────────────────────────────────────────────
const GEMINI_WEB_ALIASES = {
    // Generic names → latest versioned names
    "gemini-web/gemini-pro": "gemini-web/gemini-3.1-pro",
    "gemini-web/gemini-flash": "gemini-web/gemini-3.6-flash",
    "gemini-web/gemini-flash-thinking": "gemini-web/gemini-3.6-flash-thinking",
    // Old gemini-2.5 alias compat
    "gemini-2.5-pro": "gemini-web/gemini-3.1-pro",
    "gemini-2.5-flash": "gemini-web/gemini-3.6-flash",
    "gemini-2.5-flash-thinking": "gemini-web/gemini-3.6-flash-thinking",
    "gemini-2.5-pro-preview-05-06": "gemini-web/gemini-3.1-pro",
    "gemini-2.5-flash-preview-04-17": "gemini-web/gemini-3.6-flash",
    "gemini-2.5-flash-preview-05-20": "gemini-web/gemini-3.6-flash",
    "gemini-2.0-flash": "gemini-web/gemini-3.6-flash",
    "gemini-2.0-flash-thinking": "gemini-web/gemini-3.6-flash-thinking",
    "gemini-1.5-pro": "gemini-web/gemini-3.1-pro",
    "gemini-1.5-flash": "gemini-web/gemini-3.6-flash",
};

// ─── Image placeholder regex (ported from Python) ────────────────────────────
const IMAGE_GEN_PLACEHOLDER_RE =
    /https?:\/\/googleusercontent\.com\/(?:image_generation_content|image_retrieval|image_collection)[/\w]*\d*/g;

const IMAGE_GEN_PLACEHOLDER_PREFIX = "http://googleusercontent.com/";
const IMAGE_GEN_PLACEHOLDER_PREFIX_S = "https://googleusercontent.com/";

// ─── Image storage ────────────────────────────────────────────────────────────
const STORE_DIR = path.join(process.cwd(), "data", "gemini-web-images");
const RETENTION_SECONDS = 7 * 24 * 3600; // 7 days

const EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
};

// ─── Image keyword list for intent detection ──────────────────────────────────
// Ported from gemini2api utils/tools.py maybe_image_generation_intent
const IMAGE_INTENT_KEYWORDS = [
    // Chinese
    "画", "绘", "生成图", "生成一张", "生成一幅", "图片", "图像", "照片", "插图", "插画",
    "海报", "壁纸", "头像", "logo", "设计图", "示意图", "漫画",
    // English
    "draw", "generate image", "create image", "make image", "paint",
    "illustrate", "sketch", "render", "picture of", "photo of",
    "image of", "art of", "design",
];

class GeminiWebClient {
    constructor(logger) {
        this.logger = logger || console;
    }

    // ─── Model helpers ────────────────────────────────────────────────────────

    /**
     * Returns true if the model name is a Gemini Web model (direct or via alias).
     */
    isGeminiWebModel(name) {
        if (!name) return false;
        if (GEMINI_WEB_MODELS[name]) return true;
        if (GEMINI_WEB_ALIASES[name]) return true;
        return false;
    }

    /**
     * Resolves an alias or generic name to the canonical model name.
     * Returns the canonical name, or null if unknown.
     */
    resolveModel(name) {
        if (!name) return null;
        const aliased = GEMINI_WEB_ALIASES[name];
        if (aliased) return aliased;
        if (GEMINI_WEB_MODELS[name]) return name;
        return null;
    }

    /**
     * Build the x-goog-ext-525001261-jspb model header value.
     */
    buildModelHeader(modelName) {
        const resolved = this.resolveModel(modelName) || modelName;
        const info = GEMINI_WEB_MODELS[resolved];
        if (!info) return {};
        return {
            [MODEL_HEADER_KEY]: `[1,null,null,null,"${info.id}",null,null,0,[4],null,null,${info.capacity}]`,
            "x-goog-ext-73010989-jspb": "[0]",
            "x-goog-ext-73010990-jspb": "[0]",
        };
    }

    // ─── Payload construction ─────────────────────────────────────────────────

    /**
     * Encode the StreamGenerate f.req payload.
     * Ported from gemini_client.py _encode_payload().
     */
    encodePayload(prompt, resolvedModelName, conversationId = "") {
        const convParam = conversationId || null;
        const innerList = [[prompt], null, convParam, resolvedModelName];
        const inner = JSON.stringify(innerList);
        const outer = JSON.stringify([null, inner]);
        return outer;
    }

    /**
     * Build the complete { url, formData, headers } request params object
     * for use with BrowserManager.executeGeminiWebRequest().
     */
    buildRequestParams(resolvedModelName, snlm0e) {
        const encoded = this.encodePayload("", resolvedModelName); // prompt added in handler
        const reqId = String(Math.floor(100000 + Math.random() * 900000));

        const params = new URLSearchParams({
            bl: "boq_assistant-bard-web-server_20250424.06_p1",
            _reqid: reqId,
            rt: "c",
            "source-path": "/app",
            hl: "en",
        });

        const url = `${GENERATE_URL}?${params.toString()}`;

        const headers = {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1",
            Referer: "https://gemini.google.com/",
            Origin: "https://gemini.google.com",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
        };

        // Merge model headers
        Object.assign(headers, this.buildModelHeader(resolvedModelName));

        return { url, headers, snlm0e };
    }

    /**
     * Build the full form data for a request, given prompt and snlm0e token.
     */
    buildFormData(prompt, resolvedModelName, snlm0e, conversationId = "") {
        const encoded = this.encodePayload(prompt, resolvedModelName, conversationId);
        return {
            "f.req": encoded,
            at: snlm0e,
        };
    }

    // ─── Stream frame parsing ─────────────────────────────────────────────────

    /**
     * Parse complete wrb.fr frames from accumulated stream buffer.
     * Uses bracket-depth matching (same algorithm as Python _scan_complete_wrb_frames).
     *
     * @param {string} buf - accumulated stream buffer
     * @returns {{ frames: Array, consumed: number }} parsed frames and bytes consumed
     */
    scanWrbFrames(buf) {
        const frames = [];
        let consumed = 0;
        let i = 0;
        const n = buf.length;

        while (i < n) {
            const start = buf.indexOf('["wrb.fr"', i);
            if (start === -1) break;

            let depth = 0;
            let inStr = false;
            let esc = false;
            let end = -1;

            for (let j = start; j < n; j++) {
                const c = buf[j];
                if (inStr) {
                    if (esc) {
                        esc = false;
                    } else if (c === "\\") {
                        esc = true;
                    } else if (c === '"') {
                        inStr = false;
                    }
                } else {
                    if (c === '"') {
                        inStr = true;
                    } else if (c === "[") {
                        depth++;
                    } else if (c === "]") {
                        depth--;
                        if (depth === 0) {
                            end = j;
                            break;
                        }
                    }
                }
            }

            if (end === -1) break; // incomplete frame, wait for more chunks

            const elemStr = buf.slice(start, end + 1);
            try {
                const elem = JSON.parse(elemStr);
                frames.push(elem);
            } catch (_) {
                // skip malformed frame
            }
            consumed = end + 1;
            i = end + 1;
        }

        return { frames, consumed };
    }

    /**
     * Extract (text, conversationId) from a single wrb.fr frame.
     * Ported from Python _extract_text_from_wrb().
     *
     * @param {Array} elem - parsed wrb.fr element
     * @returns {{ text: string|null, convId: string }}
     */
    extractTextFromWrb(elem) {
        try {
            if (!Array.isArray(elem) || elem.length < 3 || elem[0] !== "wrb.fr") {
                return { text: null, convId: "" };
            }
            const rp = elem[2];
            if (typeof rp !== "string") return { text: null, convId: "" };

            const payload = JSON.parse(rp);
            if (!Array.isArray(payload) || payload.length < 5) return { text: null, convId: "" };

            const conv = payload[1] ? String(payload[1]) : "";
            let text = null;

            const cands = payload[4];
            if (Array.isArray(cands) && cands.length > 0) {
                const c0 = cands[0];
                if (
                    Array.isArray(c0) &&
                    c0.length > 1 &&
                    Array.isArray(c0[1]) &&
                    c0[1].length > 0 &&
                    typeof c0[1][0] === "string"
                ) {
                    text = c0[1][0];
                }
            }
            return { text, convId: conv };
        } catch (_) {
            return { text: null, convId: "" };
        }
    }

    /**
     * Extract generated images from a wrb.fr frame.
     * Ported from Python _images_from_wrb / _extract_generated_images.
     *
     * @param {Array} elem - parsed wrb.fr element
     * @returns {Array} array of { url, mime, width, height, filename }
     */
    extractImagesFromWrb(elem) {
        try {
            if (!Array.isArray(elem) || elem.length < 3 || elem[0] !== "wrb.fr") return [];
            const rp = elem[2];
            if (typeof rp !== "string") return [];
            const payload = JSON.parse(rp);
            if (!Array.isArray(payload) || payload.length < 5) return [];
            const cands = payload[4];
            if (!Array.isArray(cands) || cands.length === 0) return [];
            return this._extractGeneratedImages(cands[0]);
        } catch (_) {
            return [];
        }
    }

    /**
     * Extract AI-generated images from a candidate array.
     * Ported from Python GeminiWebClient._extract_generated_images().
     * Structure: candidate[12][7][0] = array of image objects.
     */
    _extractGeneratedImages(candidate) {
        try {
            if (!Array.isArray(candidate) || candidate.length <= 12) return [];
            const c12 = candidate[12];
            if (!Array.isArray(c12) || c12.length <= 7) return [];
            const arr = c12[7];
            if (!Array.isArray(arr) || arr.length === 0) return [];
            const imgList = arr[0];
            if (!Array.isArray(imgList)) return [];

            const out = [];
            for (const img of imgList) {
                try {
                    const meta = img[0][3]; // [null,1,filename,URL,...,mime,...,[w,h,size]]
                    const url = meta[3];
                    if (typeof url !== "string" || !url.startsWith("http")) continue;
                    const filename =
                        typeof meta[2] === "string" ? meta[2] : "generated.png";
                    let mime = "image/png";
                    let width = null;
                    let height = null;
                    for (const el of meta) {
                        if (typeof el === "string" && el.startsWith("image/")) {
                            mime = el;
                        } else if (
                            Array.isArray(el) &&
                            el.length >= 2 &&
                            typeof el[0] === "number" &&
                            typeof el[1] === "number"
                        ) {
                            width = el[0];
                            height = el[1];
                        }
                    }
                    out.push({ url, mime, width, height, filename });
                } catch (_) {
                    continue;
                }
            }
            return out;
        } catch (_) {
            return [];
        }
    }

    /**
     * Parse the full (non-streaming) StreamGenerate response body.
     * Ported from Python _parse_output().
     *
     * @param {string} raw - full response text
     * @returns {{ text: string, conversationId: string, images: Array }}
     */
    parseOutput(raw) {
        const lines = raw.trim().split("\n");
        let textContent = "";
        let convId = "";
        let images = [];

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith(")]}'")) continue;
            let data;
            try {
                data = JSON.parse(line);
            } catch (_) {
                continue;
            }
            if (!Array.isArray(data)) continue;

            for (const item of data) {
                if (!Array.isArray(item) || item.length < 3) continue;
                const rawPayload = item[2];
                if (typeof rawPayload !== "string") continue;
                let payload;
                try {
                    payload = JSON.parse(rawPayload);
                } catch (_) {
                    continue;
                }
                if (!Array.isArray(payload) || payload.length < 5) continue;

                const candidates = payload[4];
                if (!Array.isArray(candidates) || candidates.length === 0) continue;
                const candidate = candidates[0];

                if (Array.isArray(candidate) && candidate.length > 1) {
                    const parts = candidate[1];
                    if (Array.isArray(parts) && parts.length > 0 && typeof parts[0] === "string") {
                        textContent = parts[0];
                    }
                }
                const imgs = this._extractGeneratedImages(candidate);
                if (imgs.length > 0) images = imgs;
                if (payload[1]) convId = String(payload[1]);
            }
        }

        // Filter image placeholder URLs (same as Python)
        if (textContent.includes("googleusercontent.com/image")) {
            textContent = textContent.replace(IMAGE_GEN_PLACEHOLDER_RE, "").trim();
        }

        return { text: textContent, conversationId: convId, images };
    }

    // ─── Stream placeholder filtering ─────────────────────────────────────────

    /**
     * Filter image placeholder URLs from streaming text, also holding back
     * partial placeholder prefixes that haven't arrived yet.
     * Ported from Python _stable_placeholder_prefix().
     *
     * @param {string} text - current accumulated text from stream frame
     * @returns {string} safe-to-emit prefix
     */
    filterImagePlaceholders(text) {
        // Remove all complete placeholder URLs
        let cleaned = text.replace(IMAGE_GEN_PLACEHOLDER_RE, "");
        let cut = cleaned.length;

        // Hold back any tail that could be a partial placeholder URL
        let searchFrom = 0;
        while (true) {
            const p = cleaned.indexOf("http", searchFrom);
            if (p === -1) break;
            const tail = cleaned.slice(p);
            for (const tmpl of [IMAGE_GEN_PLACEHOLDER_PREFIX, IMAGE_GEN_PLACEHOLDER_PREFIX_S]) {
                if (tmpl.startsWith(tail) || tail.startsWith(tmpl)) {
                    cut = Math.min(cut, p);
                    break;
                }
            }
            searchFrom = p + 1;
        }

        // Hold back partial "http" prefix at end of string
        for (const k of [3, 2, 1]) {
            if (cut === cleaned.length && cleaned.endsWith("http".slice(0, k))) {
                cut = cleaned.length - k;
                break;
            }
        }

        return cleaned.slice(0, cut);
    }

    // ─── Image intent detection ───────────────────────────────────────────────

    /**
     * Returns true if the prompt likely requests image generation.
     * Ported from gemini2api utils/tools.py maybe_image_generation_intent().
     */
    isImageIntent(prompt) {
        if (!prompt) return false;
        const lower = prompt.toLowerCase();
        return IMAGE_INTENT_KEYWORDS.some(kw => lower.includes(kw));
    }

    // ─── Message building ─────────────────────────────────────────────────────

    /**
     * Build a plain-text prompt string from OpenAI-format messages array.
     * Simple concatenation; system messages are prepended.
     */
    buildPromptFromMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) return "";

        const parts = [];
        for (const msg of messages) {
            const role = msg.role || "user";
            let content = "";
            if (typeof msg.content === "string") {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Multipart: join text parts
                content = msg.content
                    .filter(p => p.type === "text")
                    .map(p => p.text)
                    .join("\n");
            }
            if (!content) continue;

            if (role === "system") {
                parts.unshift(`[System]: ${content}`);
            } else if (role === "assistant") {
                parts.push(`[Assistant]: ${content}`);
            } else {
                parts.push(content);
            }
        }
        return parts.join("\n\n");
    }

    // ─── Image storage ────────────────────────────────────────────────────────

    /**
     * Save base64-encoded image data to disk.
     * Equivalent to Python image_store.save_image().
     *
     * @param {string} b64 - base64 encoded image bytes
     * @param {string} mime - MIME type (e.g. "image/png")
     * @returns {string} file id (e.g. "abc123.png")
     */
    saveImage(b64, mime = "image/png") {
        try {
            fs.mkdirSync(STORE_DIR, { recursive: true });
            const ext = EXT_BY_MIME[mime] || "png";
            const fid = `${crypto.randomUUID()}.${ext}`;
            const filePath = path.join(STORE_DIR, fid);
            const buf = Buffer.from(b64, "base64");
            fs.writeFileSync(filePath, buf);
            // Schedule cleanup in background (non-blocking)
            setImmediate(() => this._cleanupOldImages());
            return fid;
        } catch (e) {
            this.logger.warn(`[GeminiWebClient] saveImage error: ${e.message}`);
            throw e;
        }
    }

    /**
     * Get absolute path for an image file id, with path-traversal protection.
     * Equivalent to Python image_store.get_image_path().
     *
     * @param {string} fid - file id
     * @returns {string|null} absolute path or null if not found / invalid
     */
    getImagePath(fid) {
        if (!fid || fid.includes("/") || fid.includes("\\") || fid.includes("..")) {
            return null;
        }
        const filePath = path.join(STORE_DIR, fid);
        // Ensure the resolved path is still inside STORE_DIR
        if (!filePath.startsWith(path.resolve(STORE_DIR))) return null;
        return fs.existsSync(filePath) ? filePath : null;
    }

    /**
     * Delete images older than RETENTION_SECONDS.
     * Equivalent to Python image_store.cleanup_old().
     */
    _cleanupOldImages() {
        try {
            if (!fs.existsSync(STORE_DIR)) return;
            const now = Date.now() / 1000;
            for (const name of fs.readdirSync(STORE_DIR)) {
                const filePath = path.join(STORE_DIR, name);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile() && now - stat.mtimeMs / 1000 > RETENTION_SECONDS) {
                        fs.unlinkSync(filePath);
                    }
                } catch (_) {
                    // ignore individual file errors
                }
            }
        } catch (_) {
            // ignore cleanup errors
        }
    }
}

module.exports = GeminiWebClient;
