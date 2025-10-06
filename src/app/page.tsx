import { LiveCodingWorkspace } from "@/components/live-coding-workspace"

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_color-mix(in_oklab,_var(--primary)_20%,_transparent)_0%,_transparent_70%)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-12 md:py-16">
        <LiveCodingWorkspace />
      </div>
    </main>
  )
}
