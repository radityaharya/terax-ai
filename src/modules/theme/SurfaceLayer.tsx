import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BG_OPACITY_RENDER_FACTOR } from "@/modules/settings/store";
import { getBgImage } from "./bgImageStore";

export function SurfaceLayer() {
  const kind = usePreferencesStore((s) => s.backgroundKind);
  const imageId = usePreferencesStore((s) => s.backgroundImageId);
  const opacity = usePreferencesStore((s) => s.backgroundOpacity);
  const blur = usePreferencesStore((s) => s.backgroundBlur);
  const [url, setUrl] = useState<string | null>(null);
  const [animated, setAnimated] = useState(false);
  const lastUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (kind !== "image" || !imageId) {
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current);
        lastUrlRef.current = null;
      }
      setUrl(null);
      return;
    }
    let alive = true;
    void getBgImage(imageId).then((blob) => {
      if (!alive || !blob) return;
      const next = URL.createObjectURL(blob);
      if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current);
      lastUrlRef.current = next;
      const t = blob.type.toLowerCase();
      setAnimated(t === "image/gif" || t === "image/apng" || t === "image/webp");
      setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [kind, imageId]);

  useEffect(() => {
    const active = kind === "image" && !!url;
    document.documentElement.dataset.bg = active ? "on" : "off";
  }, [kind, url]);

  useEffect(() => {
    return () => {
      if (lastUrlRef.current) {
        URL.revokeObjectURL(lastUrlRef.current);
        lastUrlRef.current = null;
      }
      document.documentElement.dataset.bg = "off";
    };
  }, []);

  if (kind !== "image" || !url || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        backgroundImage: `url(${url})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        opacity: opacity * BG_OPACITY_RENDER_FACTOR,
        filter: blur > 0 && !animated ? `blur(${blur}px)` : undefined,
        transform: "translateZ(0)",
        willChange: "transform",
      }}
    />,
    document.body,
  );
}
