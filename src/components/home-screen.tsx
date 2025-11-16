'use client'

import { useCallback, useState } from "react"
import dynamic from "next/dynamic"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Suspense } from "react"
import { Loader2, PackageSearch } from "lucide-react"
import { SamplePickerModal } from "@/components/sample-picker-modal"
import { Button } from "@/components/ui/button"

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

export function HomeScreen() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const pickerOpen = searchParams.get("picker") === "1"
  const [pickerDocked, setPickerDocked] = useState(false)
  const [isMinimizing, setIsMinimizing] = useState(false)

  const setPickerOpen = useCallback(
    (open: boolean, options?: { dock?: boolean }) => {
      const params = new URLSearchParams(searchParams.toString())
      if (open) {
        params.set("picker", "1")
      } else {
        params.delete("picker")
      }
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
      if (open) {
        setPickerDocked(false)
      } else {
        setPickerDocked(Boolean(options?.dock))
      }
    },
    [pathname, router, searchParams]
  )

  const handleOpenPicker = useCallback(() => setPickerOpen(true), [setPickerOpen])
  const handleClosePicker = useCallback(() => setPickerOpen(false), [setPickerOpen])
  const handleMinimizePicker = useCallback(() => {
    setIsMinimizing(true)
    setTimeout(() => {
      setPickerOpen(false, { dock: true })
      setIsMinimizing(false)
    }, 180)
  }, [setPickerOpen])

  return (
    <>
      <div id="workspace">
        <Suspense fallback={<WorkspaceFallback />}>
          <LiveCodingWorkspace onOpenSamplePicker={handleOpenPicker} />
        </Suspense>
      </div>
      <SamplePickerModal
        open={pickerOpen}
        isMinimizing={isMinimizing}
        onClose={handleClosePicker}
        onMinimize={handleMinimizePicker}
      />
      {pickerDocked && (
        <div className="fixed bottom-6 right-6 z-40">
          <Button onClick={handleOpenPicker} className="shadow-lg">
            <PackageSearch className="mr-2 size-4" />
            Reopen Sample Picker
          </Button>
        </div>
      )}
    </>
  )
}

