// This entrypoint existing is what makes Plasmo add side_panel.default_path and the
// "sidePanel" permission to the generated manifest, neither shows up in package.json
import { useEffect } from "react"
import { App } from "~src/wallet/App"

import "~src/wallet/style.css"

// The popup CSS assumes a fixed 380x600 window; see "sidepanel-mode" in style.css.
document.body.classList.add("sidepanel-mode")

export default function SidePanel() {
  useEffect(() => {
    const port = chrome.runtime.connect({ name: "sidepanel" })
    // Lets background know this window's id without waiting on getContexts().
    chrome.windows
      .getCurrent()
      .then((win) => {
        if (win.id !== undefined) port.postMessage({ windowId: win.id })
      })
      .catch(() => {})
    return () => port.disconnect()
  }, [])

  return <App />
}
