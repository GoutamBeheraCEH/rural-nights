import { useEffect, useRef, useState } from "react";
import type { GameHandle, HudState } from "@/game/engine";

const RECIPES: { name: string; cost: string }[] = [
  { name: "Campfire", cost: "3 Wood + 2 Grass" },
  { name: "Torch", cost: "1 Wood + 1 Fiber" },
  { name: "Wooden Tools", cost: "4 Wood + 2 Fiber" },
  { name: "Cooked Food", cost: "2 Fruit + 1 Wood" },
  { name: "Shelter", cost: "8 Wood + 6 Grass" },
  { name: "Storage Box", cost: "5 Wood" },
  { name: "Bed", cost: "4 Wood + 4 Grass + 2 Fiber" },
  { name: "Fishing Rod", cost: "3 Wood + 3 Fiber" },
];

const QUALITIES = ["Performance", "Balanced", "Quality", "Ultra"];

const initialHud: HudState = {
  health: 100,
  hunger: 100,
  stamina: 100,
  timeLabel: "06:00",
  dayPhase: "Morning",
  prompt: null,
  inventory: {},
  message: null,
  fps: 0,
  objective: "Explore the village and gather resources.",
  quality: "Balanced",
  perf: null,
};

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-[11px] uppercase tracking-widest text-white/70">{label}</span>
      <div className="h-2 w-40 overflow-hidden rounded-full bg-black/50 ring-1 ring-white/15">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tone }}
        />
      </div>
    </div>
  );
}

export default function GameCanvas() {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GameHandle | null>(null);
  const [hud, setHud] = useState<HudState>(initialHud);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCraft, setShowCraft] = useState(false);

  useEffect(() => {
    let disposed = false;
    let handle: GameHandle | null = null;
    const el = mountRef.current;
    if (!el) return;

    let raf = 0;
    let pending: HudState | null = null;
    const pump = () => {
      if (pending) {
        setHud(pending);
        pending = null;
      }
      raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);

    (async () => {
      const { createGame } = await import("@/game/engine");
      if (disposed) return;
      handle = createGame(el, (s) => {
        pending = s;
      });
      handleRef.current = handle;
      setLoading(false);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      handle?.dispose();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyC") setShowCraft((v) => !v);
      if (e.code === "Escape") setShowCraft(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const start = () => {
    setStarted(true);
    handleRef.current?.requestPointerLock();
  };

  const inv = Object.entries(hud.inventory).filter(([, n]) => n > 0);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-[#05070f]">
      <div ref={mountRef} className="absolute inset-0" />

      {/* HUD */}
      <div className="pointer-events-none absolute inset-0 select-none font-sans text-white">
        <div className="absolute left-5 top-5 space-y-2 rounded-xl bg-black/30 p-3 backdrop-blur-sm">
          <Bar label="Health" value={hud.health} tone="linear-gradient(90deg,#ff6b6b,#ffb4a2)" />
          <Bar label="Hunger" value={hud.hunger} tone="linear-gradient(90deg,#f6a94a,#ffe0a3)" />
          <Bar label="Stamina" value={hud.stamina} tone="linear-gradient(90deg,#63d2a4,#bdf0d8)" />
        </div>

        <div className="absolute right-5 top-5 rounded-xl bg-black/30 px-4 py-3 text-right backdrop-blur-sm">
          <div className="text-2xl font-semibold tabular-nums">{hud.timeLabel}</div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-white/70">{hud.dayPhase}</div>
          <div className="mt-1 text-[10px] text-white/40">{hud.fps} fps</div>
        </div>

        <div className="absolute left-1/2 top-5 -translate-x-1/2 rounded-full bg-black/30 px-4 py-1.5 text-xs text-white/85 backdrop-blur-sm">
          {hud.objective}
        </div>

        {/* crosshair */}
        <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70 shadow" />

        {hud.prompt && (
          <div className="absolute left-1/2 top-[58%] -translate-x-1/2 rounded-md bg-black/55 px-4 py-2 text-sm backdrop-blur-sm">
            {hud.prompt}
          </div>
        )}

        {hud.message && (
          <div className="absolute left-1/2 top-[68%] -translate-x-1/2 rounded-md bg-amber-300/90 px-3 py-1.5 text-sm font-medium text-black">
            {hud.message}
          </div>
        )}

        {/* inventory hotbar */}
        <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-2">
          {inv.length === 0 && (
            <div className="rounded-lg bg-black/30 px-4 py-3 text-xs text-white/60 backdrop-blur-sm">
              Inventory empty — press E near trees, bushes and the river
            </div>
          )}
          {inv.map(([k, n]) => (
            <div
              key={k}
              className="min-w-[74px] rounded-lg bg-black/35 px-3 py-2 text-center backdrop-blur-sm ring-1 ring-white/10"
            >
              <div className="text-[10px] uppercase tracking-wider text-white/60">{k}</div>
              <div className="text-lg font-semibold tabular-nums">{n}</div>
            </div>
          ))}
        </div>

        <div className="absolute bottom-5 right-5 text-[11px] text-white/50">
          [C] Crafting · [E] Interact · [Shift] Sprint · [Space] Jump
        </div>
      </div>

      {/* Crafting */}
      {showCraft && (
        <div className="absolute bottom-24 left-1/2 w-[min(680px,92vw)] -translate-x-1/2 rounded-2xl bg-black/70 p-5 text-white backdrop-blur-md ring-1 ring-white/10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80">Crafting</h2>
            <button
              onClick={() => setShowCraft(false)}
              className="rounded-md px-2 py-1 text-xs text-white/60 hover:bg-white/10"
            >
              Close [C]
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {RECIPES.map((r) => (
              <button
                key={r.name}
                onClick={() => handleRef.current?.craft(r.name)}
                className="rounded-lg bg-white/5 px-3 py-2 text-left ring-1 ring-white/10 transition hover:bg-white/15"
              >
                <div className="text-sm font-medium">{r.name}</div>
                <div className="text-[11px] text-white/55">{r.cost}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Start overlay */}
      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-[#0a1230]/95 via-[#0a1230]/85 to-[#050810]/95 px-6 text-white">
          <div className="max-w-lg text-center">
            <p className="text-[11px] uppercase tracking-[0.35em] text-amber-200/80">A quiet open world</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Lantern Fields</h1>
            <p className="mt-4 text-sm leading-relaxed text-white/70">
              Wander a peaceful riverside countryside at dusk — villages with warm lantern light,
              wandering neighbours, distant hills and a night train crossing the bridge. Gather,
              craft, and survive gently until morning.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-2 text-left text-xs text-white/70">
              <div>WASD — Move</div>
              <div>Mouse — Look</div>
              <div>Shift — Sprint</div>
              <div>Space — Jump</div>
              <div>E — Interact / Gather</div>
              <div>C — Crafting</div>
            </div>
            <button
              onClick={start}
              disabled={loading}
              className="mt-8 rounded-full bg-amber-300 px-8 py-3 text-sm font-semibold text-black transition hover:bg-amber-200 disabled:opacity-50"
            >
              {loading ? "Building the world…" : "Enter the world"}
            </button>
            <p className="mt-3 text-[11px] text-white/40">Click the world any time to re-capture the mouse.</p>
          </div>
        </div>
      )}
    </div>
  );
}
