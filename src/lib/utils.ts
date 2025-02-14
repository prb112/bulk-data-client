import                     "colors"
import jwt            from "jsonwebtoken"
import { URL }        from "url"
import moment         from "moment"
import prompt         from "prompt-sync"
import util           from "util"
import { Response }   from "got/dist/source"
import zlib           from "zlib"
import request        from "./request"
import { Transform }  from "stream"
import { BulkDataClient, JsonObject } from "../.."


const debug = util.debuglog("app")


const HTTP_CACHE = new Map();

/**
 * Given a `baseUrl` fetches a `/.well-known/smart-configuration` statement
 * from the root of the baseUrl. Note that this request is cached by default!
 * @param baseUrl The server base url
 * @param noCache Pass true to disable caching
 */
export async function getWellKnownSmartConfig(baseUrl: string, noCache = false): Promise<Response<JsonObject>> {
    const url = new URL("/.well-known/smart-configuration", baseUrl);
    return request<JsonObject>(url, {
        responseType: "json",
        cache: noCache ? false : HTTP_CACHE
    }).then(
        x => {
            debug("Fetched .well-known/smart-configuration from %s", url)
            return x
        },
        e => {
            debug(
                "Failed to fetch .well-known/smart-configuration from %s",
                url,
                e.response?.statusCode,
                e.response?.statusMessage
            );
            throw e
        }
    );
}

/**
 * Given a `baseUrl` fetches the `CapabilityStatement`. Note that this request
 * is cached by default!
 * @param baseUrl The server base url
 * @param noCache Pass true to disable caching
 */
export async function getCapabilityStatement(baseUrl: string, noCache = false): Promise<Response<fhir4.CapabilityStatement>> {
    const url = new URL("metadata", baseUrl.replace(/\/*$/, "/"));
    return request<fhir4.CapabilityStatement>(url, {
        responseType: "json",
        cache: noCache ? false : HTTP_CACHE
    }).then(
        x => {
            debug("Fetched CapabilityStatement from %s", url)
            return x;
        },
        e => {
            debug(
                "Failed to fetch CapabilityStatement from %s",
                url,
                e.response?.statusCode,
                e.response?.statusMessage
            );
            throw e
        }
    );
}

export async function getTokenEndpointFromWellKnownSmartConfig(baseUrl: string) {
    const { body } = await getWellKnownSmartConfig(baseUrl);
    return body.token_endpoint as string || ""
}

export async function getTokenEndpointFromCapabilityStatement(baseUrl: string) {
    const oauthUrisUrl = "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris"
    const { body } = await getCapabilityStatement(baseUrl);
    try {
        // @ts-ignore
        const rest = body.rest.find(x => x.mode === "server");
        // @ts-ignore
        const ext = rest.security.extension.find(x => x.url === oauthUrisUrl).extension
        // @ts-ignore
        const node = ext.find(x => x.url === "token")
        // @ts-ignore
        return node.valueUri || node.valueUrl || node.valueString || ""
    } catch {
        return ""
    }
}

/**
 * Given a FHIR server baseURL, looks up it's `.well-known/smart-configuration`
 * and/or it's `CapabilityStatement` (whichever arrives first) and resolves with
 * the token endpoint as defined there.
 * @param baseUrl The base URL of the FHIR server
 */
export async function detectTokenUrl(baseUrl: string): Promise<string> {
    try {
        const tokenUrl = await Promise.any([
            getTokenEndpointFromWellKnownSmartConfig(baseUrl),
            getTokenEndpointFromCapabilityStatement(baseUrl)
        ]);
        debug("Detected token URL from %s -> %s", baseUrl, tokenUrl)
        return tokenUrl
    } catch {
        debug("Failed to detect token URL for FHIR server at %s", baseUrl)
        return "none"
    }
}

/**
 * Simple utility for waiting. Returns a promise that will resolve after the
 * given number of milliseconds. The timer can be aborted if an `AbortSignal`
 * is passed as second argument.
 * @param ms Milliseconds to wait
 * @param signal Pass an `AbortSignal` if you want to abort the waiting
 */
export function wait(ms: number, signal?: AbortSignal): Promise<void>
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (signal) {
                signal.removeEventListener("abort", abort);
            }
            resolve(void 0)
        }, ms);

        function abort() {
            if (timer) {
                debug("Aborting wait timeout...")
                clearTimeout(timer);
            }
            reject("Waiting aborted")
        }

        if (signal) {
            signal.addEventListener("abort", abort, { once: true });
        }
    });
}

export function formatDuration(ms: number) {
    let out = [];
    let meta = [
        { n: 1000 * 60 * 60 * 24 * 7  , label: "week" },
        { n: 1000 * 60 * 60 * 24  , label: "day" },
        { n: 1000 * 60 * 60  , label: "hour" },
        { n: 1000 * 60  , label: "minute" },
        { n: 1000  , label: "second" }
    ];

    meta.reduce((prev, cur, i, all) => {
        let chunk = Math.floor(prev / cur.n); // console.log(chunk)
        if (chunk) {
            out.push(`${chunk} ${cur.label}${chunk > 1 ? "s" : ""}`);
            return prev - chunk * cur.n
        }
        return prev
    }, ms);

    if (!out.length) {
        // @ts-ignore
        out.push(`0 ${meta.pop().label}s`);
    }

    if (out.length > 1) {
        let last = out.pop();
        out[out.length - 1] += " and " + last;
    }

    return out.join(", ")
}

export const print = (() => {
    let lastLinesLength = 0;
    
    const _print = (lines: string | string[] = "") => {
        _print.clear();
        lines = Array.isArray(lines) ? lines : [lines];
        process.stdout.write(lines.join("\n") + "\n");
        lastLinesLength = lines.length
        return _print
    }

    _print.clear = () => {
        if (lastLinesLength) {
            process.stdout.write("\x1B[" + lastLinesLength + "A\x1B[0G\x1B[0J");
        }
        return _print
    };

    _print.commit = () => {
        lastLinesLength = 0
        return _print
    };

    return _print
})();

/**
 * Given a token response, computes and returns the expiresAt timestamp.
 * Note that this should only be used immediately after an access token is
 * received, otherwise the computed timestamp will be incorrect.
 */
export function getAccessTokenExpiration(tokenResponse: BulkDataClient.TokenResponse): number
{
    const now = Math.floor(Date.now() / 1000);

    // Option 1 - using the expires_in property of the token response
    if (tokenResponse.expires_in) {
        return now + tokenResponse.expires_in;
    }

    // Option 2 - using the exp property of JWT tokens (must not assume JWT!)
    if (tokenResponse.access_token) {
        let tokenBody = jwt.decode(tokenResponse.access_token);
        if (tokenBody && typeof tokenBody == "object" && tokenBody.exp) {
            return tokenBody.exp;
        }
    }

    // Option 3 - if none of the above worked set this to 5 minutes after now
    return now + 300;
}

/**
 * Returns the byte size with units
 * @param fileSizeInBytes The size to format
 * @param useBits If true, will divide by 1000 instead of 1024
 */
export function humanFileSize(fileSizeInBytes = 0, useBits = false): string {
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

export function assert(condition: any, message="Assertion failed", details?: Record<string, any>): asserts condition {
    if (!(condition)) {
        exit(new Error(message), {
            ...details,
            type: "ASSERTION ERROR"
        })
    }
}

export function fhirInstant(input: any): string
{
    input = String(input || "");
    if (input) {
        const instant = moment(new Date(input));
        if (instant.isValid()) {
            return instant.format();
        }
    }
    return "";
}

/**
 * Generates a progress indicator
 * @param pct The percentage
 * @returns
 */
export function generateProgress(pct = 0, length = 40) {
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

export function ask(question: string): Promise<string> {
    return new Promise(resolve => {
        print.commit()
        process.stdout.write(`${question}: `);
        process.stdin.once("data", data => {
            resolve(String(data).trim());
        });
    });
}

export function exit(arg: any, details?: Record<string, any>) {
    if (!arg) {
        process.exit()
    }

    if (typeof arg == "number") {
        process.exit(arg)
    }

    print.commit()

    let exitCode = 0

    if (typeof arg == "string") {
        console.log(arg)
    }

    else {
        if (arg instanceof Error) {
            exitCode = 1
            console.log(arg.message.red)
            details = { ...details, ...arg }
        }
    }

    if (details) {
        const answer = process.env.SHOW_ERRORS || prompt()("Would you like to see error details [y/N]? ".cyan)
        if (answer.toLowerCase() == "y") {
            for (const prop in details) {
                console.log(prop.bold + ":", details[prop])
            }
        }
    }

    process.exit(exitCode)
}

export function createDecompressor(res: Response): Transform
{
    switch (res.headers["content-encoding"]) {
        case "gzip"   : return zlib.createGunzip();
        case "deflate": return zlib.createInflate();
        case "br"     : return zlib.createBrotliDecompress();

        // Even if there is no compression we need to convert from stream of
        // bytes to stream of string objects
        default       : return new Transform({
            readableObjectMode: false,
            writableObjectMode: true,
            transform(chunk, enc, cb) {
                cb(null, chunk.toString("utf8"))
            }
        })
    }
}
