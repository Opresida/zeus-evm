import ZeusLoader from "@/components/ZeusLoader";

/** Splash da rota (Next mostra durante o carregamento/abertura do app — web e PWA). */
export default function Loading() {
  return (
    <div
      data-theme="navy"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <ZeusLoader size={96} />
    </div>
  );
}
