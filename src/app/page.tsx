import dynamic from "next/dynamic"
import { Suspense } from "react"
import { Loader2 } from "lucide-react"

const LiveCodingWorkspace = dynamic(
  () =>
    import("@/components/live-coding-workspace").then(
      (mod) => mod.LiveCodingWorkspace
    ),
  {
    loading: () => <WorkspaceFallback />,
  }
)

function WorkspaceFallback() {
  return (
    <div className="flex min-h-[320px] items-center justify-center gap-2 rounded-xl border bg-muted/60 text-sm text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      Initialising Strudel engine…
    </div>
  )
}

export default function Home() {
  return (
    <main className="min-h-screen bg-black">
      <div className="mx-auto w-full max-w-5xl px-6 py-12 md:py-16">
        <Suspense fallback={<WorkspaceFallback />}>
          <LiveCodingWorkspace />
        </Suspense>
      </div>
    </main>
  )
}
