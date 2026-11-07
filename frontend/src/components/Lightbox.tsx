import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconChevronLeft, IconChevronRight, IconExternal, IconX } from "./Icons";

export interface LightboxItem {
  url: string;
  title: string;
  subtitle?: string;
}

interface Props {
  items: LightboxItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}

/** Full-window screenshot viewer: Esc closes, ← / → navigate. */
export default function Lightbox({ items, index, onIndex, onClose }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const item = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev) onIndex(index - 1);
      else if (e.key === "ArrowRight" && hasNext) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, hasPrev, hasNext, onIndex, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    stripRef.current?.querySelector(".lb-thumb.active")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);

  if (!item) return null;

  return createPortal(
    <div className="lb" role="dialog" aria-modal="true" aria-label="Screenshot viewer" onClick={onClose}>
      <header className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="lb-title">{item.title}</div>
          {item.subtitle && <div className="lb-sub">{item.subtitle}</div>}
        </div>
        <div className="lb-actions">
          <span className="lb-count">
            {index + 1} / {items.length}
          </span>
          <a className="lb-btn" href={item.url} target="_blank" rel="noreferrer" title="Open original">
            <IconExternal size={18} />
          </a>
          <button className="lb-btn" onClick={onClose} title="Close (Esc)">
            <IconX size={20} />
          </button>
        </div>
      </header>

      <div className="lb-stage">
        <button
          className="lb-nav prev"
          disabled={!hasPrev}
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index - 1);
          }}
          title="Previous (←)"
        >
          <IconChevronLeft size={26} />
        </button>
        <img key={item.url} src={item.url} alt={item.title} onClick={(e) => e.stopPropagation()} />
        <button
          className="lb-nav next"
          disabled={!hasNext}
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index + 1);
          }}
          title="Next (→)"
        >
          <IconChevronRight size={26} />
        </button>
      </div>

      {items.length > 1 && (
        <div className="lb-strip" ref={stripRef} onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => (
            <button key={it.url} className={`lb-thumb ${i === index ? "active" : ""}`} onClick={() => onIndex(i)}>
              <img src={it.url} alt="" loading="lazy" />
              <span>{it.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
