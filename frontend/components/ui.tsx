"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import { css } from "@/lib/css";

/**
 * Wrapper que aplica um estilo de hover (equivalente ao `style-hover` do
 * design). Renderiza como <div>, <button> ou <a> conforme `as`.
 */
export function Hover({
  as = "div",
  base,
  hover,
  style,
  children,
  onClick,
  href,
  target,
  title,
  className,
}: {
  as?: "div" | "button" | "a";
  base: string;
  hover?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onClick?: () => void;
  href?: string;
  target?: string;
  title?: string;
  className?: string;
}) {
  const [h, setH] = useState(false);
  const merged: CSSProperties = { ...css(base), ...(h && hover ? css(hover) : {}), ...style };
  const common = {
    style: merged,
    title,
    className,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
  };
  if (as === "button") {
    return (
      <button type="button" {...common} onClick={onClick}>
        {children}
      </button>
    );
  }
  if (as === "a") {
    return (
      <a {...common} href={href} target={target} rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <div {...common} onClick={onClick}>
      {children}
    </div>
  );
}
