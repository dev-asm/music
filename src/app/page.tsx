import dynamic from "next/dynamic"
import { Suspense } from "react"

const LiveCodingWorkspace = dynamic(
  () =>
    import("@/components/live-coding-workspace").then(
      (mod) => mod.LiveCodingWorkspace
    ),
  {
    ssr: false,
    loading: () => <WorkspaceFallback />,
  }
)

function WorkspaceFallback() {
  return (
    <div className="flex min-h-[320px] items-center justify-center rounded-xl border bg-muted/60 text-sm text-muted-foreground">
      Initialising Strudel engine…
    </div>
  )
}

export const experimental_ppr = true

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_color-mix(in_oklab,_var(--primary)_20%,_transparent)_0%,_transparent_70%)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-12 md:py-16">
        <Suspense fallback={<WorkspaceFallback />}>
          <LiveCodingWorkspace />
        </Suspense>
      </div>
    </main>
  )
}
