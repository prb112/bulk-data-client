"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDecompressor = exports.exit = exports.ask = exports.generateProgress = exports.fhirInstant = exports.assert = exports.humanFileSize = exports.getAccessTokenExpiration = exports.print = exports.formatDuration = exports.wait = exports.detectTokenUrl = exports.getTokenEndpointFromCapabilityStatement = exports.getTokenEndpointFromWellKnownSmartConfig = exports.getCapabilityStatement = exports.getWellKnownSmartConfig = void 0;
require("colors");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const url_1 = require("url");
const moment_1 = __importDefault(require("moment"));
const prompt_sync_1 = __importDefault(require("prompt-sync"));
const util_1 = __importDefault(require("util"));
const zlib_1 = __importDefault(require("zlib"));
const request_1 = __importDefault(require("./request"));
const stream_1 = require("stream");
const debug = util_1.default.debuglog("app");
const HTTP_CACHE = new Map();
/**
 * Given a `baseUrl` fetches a `/.well-known/smart-configuration` statement
 * from the root of the baseUrl. Note that this request is cached by default!
 * @param baseUrl The server base url
 * @param noCache Pass true to disable caching
 */
async function getWellKnownSmartConfig(baseUrl, noCache = false) {
    const url = new url_1.URL("/.well-known/smart-configuration", baseUrl);
    return (0, request_1.default)(url, {
        responseType: "json",
        cache: noCache ? false : HTTP_CACHE
    }).then(x => {
        debug("Fetched .well-known/smart-configuration from %s", url);
        return x;
    }, e => {
        debug("Failed to fetch .well-known/smart-configuration from %s", url, e.response?.statusCode, e.response?.statusMessage);
        throw e;
    });
}
exports.getWellKnownSmartConfig = getWellKnownSmartConfig;
/**
 * Given a `baseUrl` fetches the `CapabilityStatement`. Note that this request
 * is cached by default!
 * @param baseUrl The server base url
 * @param noCache Pass true to disable caching
 */
async function getCapabilityStatement(baseUrl, noCache = false) {
    const url = new url_1.URL("metadata", baseUrl.replace(/\/*$/, "/"));
    return (0, request_1.default)(url, {
        responseType: "json",
        cache: noCache ? false : HTTP_CACHE
    }).then(x => {
        debug("Fetched CapabilityStatement from %s", url);
        return x;
    }, e => {
        debug("Failed to fetch CapabilityStatement from %s", url, e.response?.statusCode, e.response?.statusMessage);
        throw e;
    });
}
exports.getCapabilityStatement = getCapabilityStatement;
async function getTokenEndpointFromWellKnownSmartConfig(baseUrl) {
    const { body } = await getWellKnownSmartConfig(baseUrl);
    return body.token_endpoint || "";
}
exports.getTokenEndpointFromWellKnownSmartConfig = getTokenEndpointFromWellKnownSmartConfig;
async function getTokenEndpointFromCapabilityStatement(baseUrl) {
    const oauthUrisUrl = "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris";
    const { body } = await getCapabilityStatement(baseUrl);
    try {
        // @ts-ignore
        const rest = body.rest.find(x => x.mode === "server");
        // @ts-ignore
        const ext = rest.security.extension.find(x => x.url === oauthUrisUrl).extension;
        // @ts-ignore
        const node = ext.find(x => x.url === "token");
        // @ts-ignore
        return node.valueUri || node.valueUrl || node.valueString || "";
    }
    catch {
        return "";
    }
}
exports.getTokenEndpointFromCapabilityStatement = getTokenEndpointFromCapabilityStatement;
/**
 * Given a FHIR server baseURL, looks up it's `.well-known/smart-configuration`
 * and/or it's `CapabilityStatement` (whichever arrives first) and resolves with
 * the token endpoint as defined there.
 * @param baseUrl The base URL of the FHIR server
 */
async function detectTokenUrl(baseUrl) {
    try {
        const tokenUrl = await Promise.any([
            getTokenEndpointFromWellKnownSmartConfig(baseUrl),
            getTokenEndpointFromCapabilityStatement(baseUrl)
        ]);
        debug("Detected token URL from %s -> %s", baseUrl, tokenUrl);
        return tokenUrl;
    }
    catch {
        debug("Failed to detect token URL for FHIR server at %s", baseUrl);
        return "none";
    }
}
exports.detectTokenUrl = detectTokenUrl;
/**
 * Simple utility for waiting. Returns a promise that will resolve after the
 * given number of milliseconds. The timer can be aborted if an `AbortSignal`
 * is passed as second argument.
 * @param ms Milliseconds to wait
 * @param signal Pass an `AbortSignal` if you want to abort the waiting
 */
function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (signal) {
                signal.removeEventListener("abort", abort);
            }
            resolve(void 0);
        }, ms);
        function abort() {
            if (timer) {
                debug("Aborting wait timeout...");
                clearTimeout(timer);
            }
            reject("Waiting aborted");
        }
        if (signal) {
            signal.addEventListener("abort", abort, { once: true });
        }
    });
}
exports.wait = wait;
function formatDuration(ms) {
    let out = [];
    let meta = [
        { n: 1000 * 60 * 60 * 24 * 7, label: "week" },
        { n: 1000 * 60 * 60 * 24, label: "day" },
        { n: 1000 * 60 * 60, label: "hour" },
        { n: 1000 * 60, label: "minute" },
        { n: 1000, label: "second" }
    ];
    meta.reduce((prev, cur, i, all) => {
        let chunk = Math.floor(prev / cur.n); // console.log(chunk)
        if (chunk) {
            out.push(`${chunk} ${cur.label}${chunk > 1 ? "s" : ""}`);
            return prev - chunk * cur.n;
        }
        return prev;
    }, ms);
    if (!out.length) {
        // @ts-ignore
        out.push(`0 ${meta.pop().label}s`);
    }
    if (out.length > 1) {
        let last = out.pop();
        out[out.length - 1] += " and " + last;
    }
    return out.join(", ");
}
exports.formatDuration = formatDuration;
exports.print = (() => {
    let lastLinesLength = 0;
    const _print = (lines = "") => {
        _print.clear();
        lines = Array.isArray(lines) ? lines : [lines];
        process.stdout.write(lines.join("\n") + "\n");
        lastLinesLength = lines.length;
        return _print;
    };
    _print.clear = () => {
        if (lastLinesLength) {
            process.stdout.write("\x1B[" + lastLinesLength + "A\x1B[0G\x1B[0J");
        }
        return _print;
    };
    _print.commit = () => {
        lastLinesLength = 0;
        return _print;
    };
    return _print;
})();
/**
 * Given a token response, computes and returns the expiresAt timestamp.
 * Note that this should only be used immediately after an access token is
 * received, otherwise the computed timestamp will be incorrect.
 */
function getAccessTokenExpiration(tokenResponse) {
    const now = Math.floor(Date.now() / 1000);
    // Option 1 - using the expires_in property of the token response
    if (tokenResponse.expires_in) {
        return now + tokenResponse.expires_in;
    }
    // Option 2 - using the exp property of JWT tokens (must not assume JWT!)
    if (tokenResponse.access_token) {
        let tokenBody = jsonwebtoken_1.default.decode(tokenResponse.access_token);
        if (tokenBody && typeof tokenBody == "object" && tokenBody.exp) {
            return tokenBody.exp;
        }
    }
    // Option 3 - if none of the above worked set this to 5 minutes after now
    return now + 300;
}
exports.getAccessTokenExpiration = getAccessTokenExpiration;
/**
 * Returns the byte size with units
 * @param fileSizeInBytes The size to format
 * @param useBits If true, will divide by 1000 instead of 1024
 */
function humanFileSize(fileSizeInBytes = 0, useBits = false) {
    let i = 0;
    const base = useBits ? 1000 : 1024;
    const units = [' ', ' k', ' M', ' G', ' T', 'P', 'E', 'Z', 'Y'].map(u => {
        return useBits ? u + "b" : u + "B";
    });
    while (fileSizeInBytes > base && i < units.length - 1) {
        fileSizeInBytes = fileSizeInBytes / base;
        i++;
    }
    return Math.max(fileSizeInBytes, 0).toFixed(1) + units[i];
}
exports.humanFileSize = humanFileSize;
function assert(condition, message = "Assertion failed", details) {
    if (!(condition)) {
        exit(new Error(message), {
            ...details,
            type: "ASSERTION ERROR"
        });
    }
}
exports.assert = assert;
function fhirInstant(input) {
    input = String(input || "");
    if (input) {
        const instant = (0, moment_1.default)(new Date(input));
        if (instant.isValid()) {
            return instant.format();
        }
    }
    return "";
}
exports.fhirInstant = fhirInstant;
/**
 * Generates a progress indicator
 * @param pct The percentage
 * @returns
 */
function generateProgress(pct = 0, length = 40) {
    pct = parseFloat(pct + "");
    if (isNaN(pct) || !isFinite(pct)) {
        pct = 0;
    }
    let spinner = "", bold = [], grey = [];
    for (let i = 0; i < length; i++) {
        if (i / length * 100 >= pct) {
            grey.push("▉");
        }
        else {
            bold.push("▉");
        }
    }
    if (bold.length) {
        spinner += bold.join("").bold;
    }
    if (grey.length) {
        spinner += grey.join("").grey;
    }
    return `${spinner} ${pct}%`;
}
exports.generateProgress = generateProgress;
function ask(question) {
    return new Promise(resolve => {
        exports.print.commit();
        process.stdout.write(`${question}: `);
        process.stdin.once("data", data => {
            resolve(String(data).trim());
        });
    });
}
exports.ask = ask;
function exit(arg, details) {
    if (!arg) {
        process.exit();
    }
    if (typeof arg == "number") {
        process.exit(arg);
    }
    exports.print.commit();
    let exitCode = 0;
    if (typeof arg == "string") {
        console.log(arg);
    }
    else {
        if (arg instanceof Error) {
            exitCode = 1;
            console.log(arg.message.red);
            details = { ...details, ...arg };
        }
    }
    if (details) {
        const answer = process.env.SHOW_ERRORS || (0, prompt_sync_1.default)()("Would you like to see error details [y/N]? ".cyan);
        if (answer.toLowerCase() == "y") {
            for (const prop in details) {
                console.log(prop.bold + ":", details[prop]);
            }
        }
    }
    process.exit(exitCode);
}
exports.exit = exit;
function createDecompressor(res) {
    switch (res.headers["content-encoding"]) {
        case "gzip": return zlib_1.default.createGunzip();
        case "deflate": return zlib_1.default.createInflate();
        case "br": return zlib_1.default.createBrotliDecompress();
        // Even if there is no compression we need to convert from stream of
        // bytes to stream of string objects
        default: return new stream_1.Transform({
            readableObjectMode: false,
            writableObjectMode: true,
            transform(chunk, enc, cb) {
                cb(null, chunk.toString("utf8"));
            }
        });
    }
}
exports.createDecompressor = createDecompressor;
