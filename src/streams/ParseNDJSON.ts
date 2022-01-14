import { Transform } from "stream"
import util         from "util"

export interface ParseNDJSONOptions {
    maxLineLength: number,
    expectedResourceType?: string
    expectedCount: number
}


/**
 * This is a transform stream that takes parts of NDJSON file as Buffer chunks
 * and emits one JSON object for each non-empty line
 */
export default class ParseNDJSON extends Transform
{
    /**
     * Cache the string contents that we have read so far until we reach a
     * new line
     */
    private _stringBuffer: string = "";

    /**
     * The buffer size as number of utf8 characters
     */
    private bufferSize = 0;

    /**
     * Line counter
     */
    private _line = 0;

    /**
     * Object (resource) counter
     */
    private _count = 0;

    private options: ParseNDJSONOptions = {
        maxLineLength: 1000000,
        expectedResourceType: "",
        expectedCount: -1
    }

    constructor(options?: ParseNDJSONOptions)
    {
        super({
            writableObjectMode: true,
            readableObjectMode: true
        });

        Object.assign(this.options, options || {})
    }

    get count()
    {
        return this._line;
    }

    override _transform(chunk: Buffer, encoding: any, next: (err?: Error) => any)
    {
        // Convert the chunk buffer to string
        const stringChunk = chunk.toString("utf8");

        util.debuglog(`stringChunk -> ${stringChunk}`);

        // Get the char length of the chunk
        const chunkLength = stringChunk.length;

        // Check if concatenating this chunk to the buffer will result in buffer
        // overflow. Protect against very long lines (possibly bad files without
        // EOLs).
        if (this.bufferSize + chunkLength > this.options.maxLineLength) {
            this._stringBuffer = "";
            this.bufferSize   = 0;
            return next(new Error(
                `Buffer overflow. No EOL found in ${this.options.maxLineLength
                } subsequent characters.`
            ));
        }

        // Append to buffer
        this._stringBuffer += stringChunk;
        this.bufferSize = this._stringBuffer.length;

        // The chunk might span over multiple lines
        let idx = 0;
        let jsonString = "";
        while (idx < this._stringBuffer.length){
            let eol = false;
            let ch = this._stringBuffer[idx];
            if (ch == '\n') {
                eol = true;
            } else { 
                jsonString += ch;
            }
            
            idx += 1;
            if (idx == this._stringBuffer.length || eol) { 
                console.log(jsonString);
                this._line        += 1;
                if (jsonString.trim().length) {
                    try {
                        console.log(`${this._line} ${jsonString}`);
                        const json = JSON.parse(jsonString);
    
                        if (this.options.expectedResourceType &&
                            json.resourceType !== this.options.expectedResourceType) {
                            throw new Error(`Expected each resource to have a "${
                                this.options.expectedResourceType
                            }" resourceTpe but found "${json.resourceType}"`)
                        }
    
                        this.push(json);
                        util.debuglog(`res.body -> ${json}`);
                        this._count += 1;
                    } catch (error) {
                        console.log(`res.body -> ${jsonString}`)
                        this._stringBuffer = "";
                        this.bufferSize   = 0;
                        return next(new SyntaxError(
                            `Error parsing NDJSON on line ${this._line}: ${error} ${jsonString}`
                        ));
                    }
                } else {
                    /*
                     * There shouldn't be an empty line here
                     */
                    return next(new SyntaxError(
                        `Error parsing NDJSON on line - here ${this._line} ('${idx}')`
                    ));
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
    override _flush(next: (err?: Error) => any)
    {
        try {
            if (this._stringBuffer) {
                const json = JSON.parse(this._stringBuffer);
                this._stringBuffer = "";
                this.push(json);
            }
            next();
        } catch (error) {
            next(new SyntaxError(
                `Error parsing NDJSON on line ${this._line + 1}: ${error}`
            ));
        }
    }

    override _final(next: (error?: Error) => any) {
        if (this.options.expectedCount > -1 && this._count !== this.options.expectedCount) {
            return next(new Error(`Expected ${this.options.expectedCount
            } resources but found ${this._count}`))
        }
        next()
    }
}

