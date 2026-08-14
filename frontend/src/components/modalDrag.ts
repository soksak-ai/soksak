import { useRef, useState } from "react";

// Shared hook for the reference draggable modal (header ⠿ grip). Position null = default,
// centered transform; after a drag it is fixed to absolute coordinates relative to the container.

export function useDraggableModal() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const onHeaderDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const card = cardRef.current;
    const overlay = card?.parentElement;
    if (!card || !overlay) return;
    e.preventDefault();
    const or = overlay.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const offX = e.clientX - cr.left;
    const offY = e.clientY - cr.top;
    const onMove = (ev: MouseEvent) => {
      const x = Math.max(
        8,
        Math.min(or.width - cr.width - 8, ev.clientX - or.left - offX),
      );
      const y = Math.max(
        8,
        Math.min(or.height - cr.height - 8, ev.clientY - or.top - offY),
      );
      setPos({ x, y });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  };

  const cardStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, transform: "none" }
    : {};
  return { cardRef, cardStyle, onHeaderDown };
}
