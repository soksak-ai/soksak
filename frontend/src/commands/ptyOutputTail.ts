export interface OutputTailState {
  capacityBytes: number;
  retainedBytes: number;
  droppedBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Keeps the newest complete UTF-8 characters within a fixed byte capacity. */
export class BoundedTextTail {
  readonly #capacityBytes: number;
  readonly #chunks: Uint8Array[] = [];
  #retainedBytes = 0;
  #droppedBytes = 0;

  constructor(capacityBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
      throw new RangeError("capacityBytes must be a positive safe integer");
    }
    this.#capacityBytes = capacityBytes;
  }

  append(text: string): void {
    if (!text) return;
    const bytes = encoder.encode(text);
    this.#chunks.push(bytes);
    this.#retainedBytes += bytes.byteLength;

    while (this.#retainedBytes > this.#capacityBytes) {
      const first = this.#chunks[0];
      const overflow = this.#retainedBytes - this.#capacityBytes;
      if (first.byteLength <= overflow) {
        this.#chunks.shift();
        this.#retainedBytes -= first.byteLength;
        this.#droppedBytes += first.byteLength;
        continue;
      }

      let cut = overflow;
      while (cut < first.byteLength && isContinuationByte(first[cut])) cut += 1;
      this.#chunks[0] = first.slice(cut);
      this.#retainedBytes -= cut;
      this.#droppedBytes += cut;
    }
  }

  text(): string {
    const joined = new Uint8Array(this.#retainedBytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(joined);
  }

  state(): OutputTailState {
    return {
      capacityBytes: this.#capacityBytes,
      retainedBytes: this.#retainedBytes,
      droppedBytes: this.#droppedBytes,
    };
  }
}
