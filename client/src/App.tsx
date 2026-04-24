import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState<string>("…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { status: string }) => setStatus(d.status))
      .catch(() => setStatus("error"));
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 font-mono">
      <div className="text-center">
        <div className="text-xs uppercase tracking-widest text-neutral-500">
          Branching Workbook
        </div>
        <div className="mt-2 text-3xl">
          /api/health <span className="text-neutral-500">→</span> {status}
        </div>
      </div>
    </div>
  );
}
