import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const GameCanvas = lazy(() => import("@/components/GameCanvas"));

const title = "Lantern Fields — 3D Peaceful Village Survival Sandbox";
const description =
  "Explore a calm riverside countryside in 3D: lantern-lit villages, wandering neighbours, a night train across the bridge. Gather, craft and survive gently until dawn.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Loading() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#05070f] text-sm text-white/60">
      Building the world…
    </div>
  );
}

function Index() {
  return (
    <main>
      <h1 className="sr-only">Lantern Fields — 3D peaceful village survival sandbox</h1>
      <ClientOnly fallback={<Loading />}>
        <Suspense fallback={<Loading />}>
          <GameCanvas />
        </Suspense>
      </ClientOnly>
    </main>
  );
}
