// @vitest-environment jsdom
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { commitDomLayout } from "./domLayoutCommit";

describe("commitDomLayout — the DOM is final before the completion event", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("leaves the slot DOM at its final geometry, not only the React state, once the call returns", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let setWidth!: Dispatch<SetStateAction<number>>;
    const Fixture = () => {
      const [width, update] = useState(212);
      setWidth = update;
      return <div data-slot style={{ width }} />;
    };
    act(() => root!.render(<Fixture />));

    commitDomLayout(() => setWidth(332));

    expect(host.querySelector<HTMLElement>("[data-slot]")?.style.width).toBe("332px");
  });
});
