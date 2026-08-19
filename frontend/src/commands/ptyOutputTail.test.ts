import { describe, expect, it } from "vitest";

import { BoundedTextTail } from "./ptyOutputTail";

describe("BoundedTextTail", () => {
  it("keeps at most the declared UTF-8 byte capacity", () => {
    const tail = new BoundedTextTail(8);
    const threeKoreanSyllables = "\uAC00\uB098\uB2E4";

    tail.append(threeKoreanSyllables);

    expect(tail.text()).toBe(threeKoreanSyllables.slice(1));
    expect(tail.state()).toEqual({ capacityBytes: 8, retainedBytes: 6, droppedBytes: 3 });
  });

  it("removes the oldest complete characters as more output arrives", () => {
    const tail = new BoundedTextTail(8);
    const threeKoreanSyllables = "\uAC00\uB098\uB2E4";
    tail.append(threeKoreanSyllables);

    tail.append("abc");

    expect(tail.text()).toBe(`${threeKoreanSyllables.slice(2)}abc`);
    expect(tail.state()).toEqual({ capacityBytes: 8, retainedBytes: 6, droppedBytes: 6 });
  });

  it("bounds a single output chunk larger than the capacity", () => {
    const tail = new BoundedTextTail(4);

    tail.append("0123456789");

    expect(tail.text()).toBe("6789");
    expect(tail.state()).toEqual({ capacityBytes: 4, retainedBytes: 4, droppedBytes: 6 });
  });
});
