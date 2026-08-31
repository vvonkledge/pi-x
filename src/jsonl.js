// Strict LF-delimited JSONL, as RPC mode requires. A generic line reader is not
// protocol compliant: Node `readline` also splits on U+2028 and U+2029, which are
// legal inside JSON strings, so a record carrying one would be torn in half.

export class ProtocolViolation extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ProtocolViolation";
    this.reason = reason;
  }
}

export class JsonlReader {
  #buffer = "";
  #closed = false;

  // Feed a chunk and return the records it completed. Throws ProtocolViolation
  // rather than skipping a line: an unparseable stream is never a successful run.
  push(chunk) {
    if (this.#closed) {
      throw new ProtocolViolation("data after end of stream");
    }
    this.#buffer += chunk;
    const records = [];
    for (;;) {
      const lf = this.#buffer.indexOf("\n");
      if (lf === -1) break;
      let line = this.#buffer.slice(0, lf);
      this.#buffer = this.#buffer.slice(lf + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") continue;
      records.push(parseRecord(line));
    }
    return records;
  }

  // Signal EOF. A trailing partial line is a torn record, not a usable one.
  end() {
    this.#closed = true;
    if (this.#buffer !== "") {
      const pending = this.#buffer;
      this.#buffer = "";
      throw new ProtocolViolation(
        `stream ended mid-record after ${pending.length} bytes`,
      );
    }
  }
}

function parseRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw new ProtocolViolation("record is not valid JSON");
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new ProtocolViolation("record is not a JSON object");
  }
  if (typeof record.type !== "string") {
    throw new ProtocolViolation("record has no string type");
  }
  return record;
}
