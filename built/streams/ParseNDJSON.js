"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const stream_1 = require("stream");
const util_1 = __importDefault(require("util"));
/**
 * This is a transform stream that takes parts of NDJSON file as Buffer chunks
 * and emits one JSON object for each non-empty line
 */
class ParseNDJSON extends stream_1.Transform {
    constructor(options) {
        super({
            writableObjectMode: true,
            readableObjectMode: true
        });
        /**
         * Cache the string contents that we have read so far until we reach a
         * new line
         */
        this._stringBuffer = "";
        /**
         * The buffer size as number of utf8 characters
         */
        this.bufferSize = 0;
        /**
         * Line counter
         */
        this._line = 0;
        /**
         * Object (resource) counter
         */
        this._count = 0;
        this.options = {
            maxLineLength: 1000000,
            expectedResourceType: "",
            expectedCount: -1
        };
        Object.assign(this.options, options || {});
    }
    get count() {
        return this._line;
    }
    _transform(chunk, encoding, next) {
        // Convert the chunk buffer to string
        const stringChunk = chunk.toString("utf8");
        util_1.default.debuglog(`stringChunk -> ${stringChunk}`);
        // Get the char length of the chunk
        const chunkLength = stringChunk.length;
        // Check if concatenating this chunk to the buffer will result in buffer
        // overflow. Protect against very long lines (possibly bad files without
        // EOLs).
        if (this.bufferSize + chunkLength > this.options.maxLineLength) {
            this._stringBuffer = "";
            this.bufferSize = 0;
            return next(new Error(`Buffer overflow. No EOL found in ${this.options.maxLineLength} subsequent characters.`));
        }
        // Append to buffer
        this._stringBuffer += stringChunk;
        this.bufferSize = this._stringBuffer.length;
        // The chunk might span over multiple lines
        let idx = 0;
        let jsonString = "";
        while (idx < this._stringBuffer.length) {
            let eol = false;
            let ch = this._stringBuffer[idx];
            if (ch == '\n') {
                eol = true;
            }
            else {
                jsonString += ch;
            }
            idx += 1;
            if (idx == this._stringBuffer.length || eol) {
                console.log(jsonString);
                this._line += 1;
                if (jsonString.trim().length) {
                    try {
                        console.log(`${this._line} ${jsonString}`);
                        const json = JSON.parse(jsonString);
                        if (this.options.expectedResourceType &&
                            json.resourceType !== this.options.expectedResourceType) {
                            throw new Error(`Expected each resource to have a "${this.options.expectedResourceType}" resourceTpe but found "${json.resourceType}"`);
                        }
                        this.push(json);
                        util_1.default.debuglog(`res.body -> ${json}`);
                        this._count += 1;
                    }
                    catch (error) {
                        console.log(`res.body -> ${jsonString}`);
                        this._stringBuffer = "";
                        this.bufferSize = 0;
                        return next(new SyntaxError(`Error parsing NDJSON on line ${this._line}: ${error} ${jsonString}`));
                    }
                }
                else {
                    /*
                     * There shouldn't be an empty line here
                     */
                    return next(new SyntaxError(`Error parsing NDJSON on line - here ${this._line} ('${idx}')`));
                }
                jsonString = "";
            }
        }
        this._stringBuffer = "";
        next();
    }
    /**
     * After we have consumed and transformed the entire input, the buffer may
     * still contain the last line so make sure we handle that as well
     * @param {function} next
     */
    _flush(next) {
        try {
            if (this._stringBuffer) {
                const json = JSON.parse(this._stringBuffer);
                this._stringBuffer = "";
                this.push(json);
            }
            next();
        }
        catch (error) {
            next(new SyntaxError(`Error parsing NDJSON on line ${this._line + 1}: ${error}`));
        }
    }
    _final(next) {
        if (this.options.expectedCount > -1 && this._count !== this.options.expectedCount) {
            return next(new Error(`Expected ${this.options.expectedCount} resources but found ${this._count}`));
        }
        next();
    }
}
exports.default = ParseNDJSON;
