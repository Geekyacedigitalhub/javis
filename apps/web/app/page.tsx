import Link from "next/link";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", padding: "48px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ color: "#34d399", fontWeight: 800, letterSpacing: "0.14em" }}>FROSH</div>
      <h1 style={{ fontSize: "clamp(42px, 7vw, 76px)", margin: "18px 0 12px" }}>
        Your personal AI operating system.
      </h1>
      <p style={{ maxWidth: 680, color: "#a7f3d0", fontSize: 18, lineHeight: 1.6 }}>
        Intelligence, memory, devices, tools and automation in one system.
      </p>
      <Link href="/memory" style={{
        display: "inline-block", marginTop: 28, padding: "13px 18px",
        borderRadius: 10, background: "#16a34a", color: "white", textDecoration: "none", fontWeight: 700
      }}>
        Open Memory Manager
      </Link>
    </main>
  );
}
