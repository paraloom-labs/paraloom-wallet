import { createRoot } from "react-dom/client"
import { App } from "~src/wallet/App"

import "~src/wallet/style.css"

// Only the anchored toolbar popup flips the last-used-surface preference,
// not an openWalletWindow floating window.
chrome.windows
  .getCurrent()
  .then((win) => {
    if (win.type !== "popup") {
      void chrome.runtime.sendMessage({ type: "POPUP_OPENED" }).catch(() => {})
    }
  })
  .catch(() => {})

const root = createRoot(document.getElementById("root")!)
root.render(<App />)
