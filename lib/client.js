/**
 * dsh-titlebar-restart — browser half.
 *
 * The Windows caption menubar (应用 / 编辑) is not a Web slot: `lib/preload-app.cjs`
 * mounts it as a fixed shadow-DOM host (`<div data-windows-menu>`) with an open
 * shadow root, so the slot system cannot reach it. This module waits for that
 * host, appends one more `<button role="menuitem">` into its `[role=menubar]`,
 * and lets the preload's own `button { ... }` rule style it — same 28px height,
 * same 10px padding, same 6px radius, same 14px font and 2px gap as 编辑.
 *
 * Clicking toggles to a confirmation label; the second click POSTs
 * `/api/titlebar-restart`, which is what actually stops and relaunches the app.
 *
 * On any non-Desktop carrier (plain `dsh web`, macOS, Linux) the host never
 * appears and this module stays inert.
 */

window.__ModuleLoader__.load({
  id: 'dsh-titlebar-restart',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const LABEL_IDLE = '重启'
    const LABEL_CONFIRM = '确认重启'
    const LABEL_BUSY = '重启中…'
    const LABEL_FAILED = '重启失败'
    const CONFIRM_MS = 4000

    let button = null
    let state = 'idle'
    let revertTimer = 0

    function setLabel (text) {
      if (button !== null) button.textContent = text
    }

    function reset () {
      state = 'idle'
      clearTimeout(revertTimer)
      setLabel(LABEL_IDLE)
      if (button !== null) {
        button.disabled = false
        button.removeAttribute('aria-label')
      }
    }

    function armConfirm () {
      state = 'confirm'
      setLabel(LABEL_CONFIRM)
      if (button !== null) button.setAttribute('aria-label', '再次点击确认重启 DSH')
      clearTimeout(revertTimer)
      revertTimer = setTimeout(reset, CONFIRM_MS)
    }

    function failed () {
      state = 'failed'
      if (button !== null) button.disabled = false
      setLabel(LABEL_FAILED)
      clearTimeout(revertTimer)
      revertTimer = setTimeout(reset, 2500)
    }

    function send () {
      clearTimeout(revertTimer)
      state = 'busy'
      setLabel(LABEL_BUSY)
      if (button !== null) button.disabled = true
      fetch('/api/titlebar-restart', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then((payload) => {
          if (payload !== null && typeof payload === 'object' && payload.ok === true) return
          throw new Error('refused')
        })
        .catch(failed)
    }

    function onClick (event) {
      event.preventDefault()
      event.stopPropagation()
      if (state === 'busy') return
      if (state === 'confirm') {
        send()
        return
      }
      armConfirm()
    }

    function createButton () {
      const node = document.createElement('button')
      node.type = 'button'
      node.setAttribute('role', 'menuitem')
      node.setAttribute('data-titlebar-restart', '')
      node.textContent = LABEL_IDLE
      /* Keep the editor focus, exactly like the preload's own caption buttons. */
      node.addEventListener('pointerdown', (event) => {
        event.preventDefault()
      })
      node.addEventListener('mousedown', (event) => {
        event.preventDefault()
      })
      node.addEventListener('click', onClick)
      return node
    }

    function menubar () {
      const host = document.querySelector('[data-windows-menu]')
      const root = host === null ? null : host.shadowRoot
      return root === null ? null : root.querySelector('[role="menubar"]')
    }

    function mount () {
      const bar = menubar()
      if (bar === null) return false
      const current = bar.querySelector('[data-titlebar-restart]')
      if (current !== null) {
        if (current !== button) button = current
        return true
      }
      button = createButton()
      bar.append(button)
      return true
    }

    exports.apply = function apply (ctx) {
      mount()
      let period = 1000
      let timer = setInterval(tick, period)
      const observer = new MutationObserver(mount)
      observer.observe(document.documentElement, { childList: true, subtree: true })

      /* The menubar is re-created when the window language changes; keep looking,
       * but stop paying for a subtree observer once the page has settled. */
      const settle = setTimeout(() => observer.disconnect(), 120000)

      function tick () {
        const found = mount()
        if (found && period !== 5000) {
          period = 5000
          clearInterval(timer)
          timer = setInterval(tick, period)
        }
      }

      const outside = (event) => {
        if (state !== 'confirm') return
        if (button !== null && event.composedPath().indexOf(button) !== -1) return
        reset()
      }
      document.addEventListener('pointerdown', outside, true)

      const dispose = () => {
        clearInterval(timer)
        clearTimeout(revertTimer)
        clearTimeout(settle)
        observer.disconnect()
        document.removeEventListener('pointerdown', outside, true)
        if (button !== null && button.isConnected) button.remove()
        button = null
      }
      if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') ctx.effect(() => dispose)
      return dispose
    }

    exports.inject = []
    return module.exports
  },
})
