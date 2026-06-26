import type { CSSProperties } from "react";

/**
 * ZeusLoader — spinner "dual-ring" do ZEUS (monograma animado): anel dourado externo + anel fino
 * interno girando em sentidos opostos, com o raio pulsando. ~1KB, sem dependências. Os keyframes
 * (zeus-spin/zeus-pulse) vivem em globals.css e respeitam prefers-reduced-motion.
 */
export default function ZeusLoader({
  size = 96,
  speed = 1.1, // segundos por volta (maior = mais lento)
  color = "#d6b25e", // raio + anel externo (dourado)
  innerColor = "#8a96b0", // anel interno
  trackColor = "#1d2942", // trilho de fundo
  glow = true,
  label = "Carregando",
  style,
}: {
  size?: number | string;
  speed?: number;
  color?: string;
  innerColor?: string;
  trackColor?: string;
  glow?: boolean;
  label?: string;
  style?: CSSProperties;
}) {
  const spin = (mult: number, rev?: boolean): CSSProperties => ({
    transformBox: "fill-box",
    transformOrigin: "center",
    animation: `zeus-spin ${speed * mult}s linear infinite${rev ? " reverse" : ""}`,
  });
  const boltAnim: CSSProperties = { animation: `zeus-pulse ${speed * 1.7}s ease-in-out infinite` };
  const bolt = "M13 2 4 14h6l-1 8 9-12h-6z";
  const boltTf = "translate(30.2,28.4) scale(1.8)";

  return (
    <span
      data-zeus-loader-root=""
      role="status"
      aria-label={label}
      style={{ display: "inline-block", width: size, height: size, ...style }}
    >
      <svg viewBox="0 0 100 100" width="100%" height="100%" style={{ display: "block", overflow: "visible" }}>
        <circle cx="50" cy="50" r="42" fill="none" stroke={trackColor} strokeWidth="3.5" />
        {glow && (
          <path d={bolt} transform={boltTf} fill={color} style={{ filter: "blur(4px)", opacity: 0.4, ...boltAnim }} />
        )}
        <circle cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeDasharray="46 218" style={spin(1, false)} />
        <circle cx="50" cy="50" r="33" fill="none" stroke={innerColor} strokeWidth="2" strokeLinecap="round" strokeDasharray="26 182" style={spin(1.6, true)} />
        <path d={bolt} transform={boltTf} fill={color} style={boltAnim} />
      </svg>
    </span>
  );
}
