/** A half-open range of character offsets into the source text. */
export interface Span {
  start: number;
  end: number;
}

/** Source text plus a line index, for turning offsets into line and column numbers. */
export class SourceFile {
  private readonly lineStarts: number[] = [0];

  constructor(
    readonly name: string,
    readonly text: string,
  ) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  /** 1-based line and column of an offset, found by binary search over line starts. */
  position(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.lineStarts[lo]! + 1 };
  }

  /** The text of a 1-based line, without its line break. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? this.text.length;
    const end = this.lineStarts[line] ?? this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$/, "");
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}
