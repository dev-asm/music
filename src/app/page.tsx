import { Suspense } from "react"
import { AppShell } from "@/components/app-shell"
import { HomeScreen } from "@/components/home-screen"
import { Loader2 } from "lucide-react"

export default function Home() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="flex min-h-[320px] items-center justify-center gap-2 rounded-xl border bg-muted/60 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            Loading Strudel workspace…
          </div>
        }
      >
        <HomeScreen />
      </Suspense>
    </AppShell>
  )
}
