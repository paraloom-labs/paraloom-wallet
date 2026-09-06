export const POPUP_PAGE = "popup.html"

let opening = false

export async function openWalletWindow(): Promise<void> {
  if (opening) return
  opening = true
  const WIDTH = 400
  const HEIGHT = 620
  try {
    // Anchor the popup to the top-right of the focused browser window, like
    // Phantom — otherwise Chrome drops it at the top-left of the screen.
    let left: number | undefined
    let top: number | undefined
    try {
      const win = await chrome.windows.getLastFocused()
      if (typeof win.left === "number" && typeof win.width === "number") {
        left = Math.max(0, win.left + win.width - WIDTH - 24)
        top = (win.top ?? 0) + 24
      }
    } catch {
      // Fall back to Chrome's default placement.
    }
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL(POPUP_PAGE),
        type: "popup",
        width: WIDTH,
        height: HEIGHT,
        left,
        top,
        focused: true
      })
    } catch {
      // Guessed position can land off-screen on multi-monitor setups; retry unpositioned.
      await chrome.windows.create({
        url: chrome.runtime.getURL(POPUP_PAGE),
        type: "popup",
        width: WIDTH,
        height: HEIGHT,
        focused: true
      })
    }
  } finally {
    opening = false
  }
}
