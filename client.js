// dsh-qqnt-chat-export — browser half.
//
// Hand-authored client bundle in the DSH module-loader factory format:
// `window.__ModuleLoader__.load({ id, factory })`. The factory gets the
// module-table `require`, so only shell-externalized modules may be imported
// (react / react/jsx-runtime are in the static table).
//
// Two entry points, one payload:
//   * a global panel — an icon in the left sidebar rail plus the `main` panel
//     it opens, exactly like the built-in Plugins page and dsh-context;
//   * an optional tab for `dsh-better-sidebar` (right column), registered only
//     when that plugin is active — `ctx.inject` simply never fires otherwise.
// Both render the same iframe of the plugin's own local UI, so search/export/
// settings stay one implementation. Nothing but the address and a few counts
// crosses the /api/qqnt/panel route: chat text never enters DSH's DOM.
window.__ModuleLoader__.load({
  id: 'dsh-qqnt-chat-export',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    let jsx = require('react/jsx-runtime')

    /** Slot id and main-panel key; both must match or `selectPanel` throws. */
    const PANEL_ID = 'qqnt-chat-export'
    const LABEL = 'QQ 聊天记录'
    const ROUTE = '/api/qqnt/panel'
    const CSS_ID = 'dsh-qqnt-chat-export/panel.css'

    // ── styles (injected once; the shell has no CSS-module hook for plugins) ──
    if (typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-qqnt-chat-export'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = [
        '.qqnt-panel{display:flex;flex-direction:column;height:100%;min-height:0;',
        'color:var(--dsw-alias-label-primary,inherit);',
        'background:var(--dsw-alias-bg-layer-1,transparent)}',
        '.qqnt-panel-head{display:flex;align-items:center;gap:10px;flex:none;',
        'min-height:40px;padding:0 12px;font-size:12px;',
        'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}',
        '.qqnt-panel-title{font-weight:600;white-space:nowrap}',
        '.qqnt-panel-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;',
        'white-space:nowrap;opacity:.7}',
        '.qqnt-panel-btn{flex:none;font:inherit;font-size:12px;padding:3px 10px;cursor:pointer;',
        'color:inherit;background:transparent;border-radius:6px;',
        'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35))}',
        '.qqnt-panel-btn:hover{border-color:var(--dsw-alias-brand-primary,#0969da);',
        'color:var(--dsw-alias-brand-primary,#0969da)}',
        '.qqnt-panel-body{flex:1;min-height:0;position:relative}',
        '.qqnt-panel-frame{display:block;width:100%;height:100%;border:0;background:#fff}',
        '.qqnt-panel-note{display:flex;flex-direction:column;align-items:center;',
        'justify-content:center;gap:10px;height:100%;padding:24px;text-align:center;',
        'font-size:13px;line-height:1.7}',
        '.qqnt-panel-note p{margin:0;max-width:520px;opacity:.8}',
        '.qqnt-panel-error{color:var(--dsw-alias-label-danger,#cf222e)}',
      ].join('')
      document.head.appendChild(tag)
    }

    /** Speech bubble with three lines: "chat history" without a second font. */
    function ChatExportIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return jsx.jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        children: [
          jsx.jsx('path', {
            d: 'M2.2 3.4h11.6v7.1H7.1L3.9 13v-2.5H2.2z',
          }),
          jsx.jsx('path', { d: 'M4.6 5.9h6.8' }),
          jsx.jsx('path', { d: 'M4.6 8.1h4.6' }),
        ],
      })
    }

    /** `/api/qqnt/panel`: where the local UI lives plus index counts. */
    function usePanelInfo() {
      const [state, setState] = react.useState({ loading: true, info: null, error: '' })
      const load = react.useCallback(() => {
        let alive = true
        setState({ loading: true, info: null, error: '' })
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((res) => res.json().catch(() => ({})).then((body) => ({ ok: res.ok, body })))
          .then(({ ok, body }) => {
            if (!alive) return
            if (!ok) throw new Error((body && body.error) || '读取面板信息失败')
            setState({ loading: false, info: body, error: '' })
          })
          .catch((error) => {
            if (!alive) return
            setState({ loading: false, info: null, error: String(error.message || error) })
          })
        return () => { alive = false }
      }, [])
      react.useEffect(load, [load])
      return { ...state, reload: load }
    }

    const number = (value) => Number(value || 0).toLocaleString('zh-CN')

    /** "1 245 880 条 · 293 会话 · 上次同步 3 分钟前", or '' when unknown. */
    function describe(info) {
      if (!info) return ''
      if (!info.indexed) return '还没有索引：先在页面里建立索引'
      const parts = [`${number(info.messages)} 条`, `${number(info.chats)} 个会话`]
      const last = Number(info.lastSync || 0)
      if (last > 0) {
        const minutes = Math.round((Date.now() / 1000 - last) / 60)
        parts.push(minutes < 1 ? '刚刚同步' : `上次同步 ${minutes} 分钟前`)
      }
      return parts.join(' · ')
    }

    /** Full-size iframe of the plugin UI; the frame owns every interaction. */
    function Frame(props) {
      const [stamp, setStamp] = react.useState(0)
      const info = props.info
      const openInBrowser = () => {
        if (info && info.url) window.open(info.url, '_blank', 'noopener')
      }
      // The plugin's own UI is loopback HTTP. An HTTPS DSH (--tls-cert or a
      // TLS proxy) would have the browser block this iframe as mixed content,
      // so say why instead of showing a blank pane.
      const insecureFrame = typeof window !== 'undefined'
        && window.location && window.location.protocol === 'https:'
        && Boolean(info && info.url) && info.url.startsWith('http://')
      const body = insecureFrame
        ? jsx.jsx('div', {
          className: 'qqnt-panel-note',
          children: [
            jsx.jsx('p', {
              className: 'qqnt-panel-error',
              children: 'DSH 正通过 HTTPS 打开，浏览器会拦截 http://127.0.0.1 的内嵌页面。',
            }),
            jsx.jsx('p', {
              children: '请改用 http://127.0.0.1 打开 DSH，或在浏览器里单独打开插件页面。',
            }),
            jsx.jsx('button', {
              className: 'qqnt-panel-btn',
              type: 'button',
              onClick: openInBrowser,
              children: '在浏览器打开',
            }),
          ],
        })
        : info && info.url
          ? jsx.jsx('iframe', {
            className: 'qqnt-panel-frame',
            src: info.url,
            title: LABEL,
            // Reloading the frame is the only "refresh" that reaches the page.
            key: `${info.url}#${stamp}`,
          })
          : jsx.jsx('div', {
          className: 'qqnt-panel-note',
          children: [
            jsx.jsx('p', {
              className: info ? 'qqnt-panel-error' : '',
              children: info
                ? `网页服务没有启动（端口 ${info.port || 0}）。把设置里的网页端口改成非 0，再回来点刷新；也可以直接改回 46728。`
                : '正在读取网页服务地址…',
            }),
            info && !info.url
              ? jsx.jsx('button', {
                className: 'qqnt-panel-btn',
                type: 'button',
                onClick: props.reload,
                children: '刷新',
              })
              : null,
          ],
        })
      return jsx.jsx('div', {
        className: 'qqnt-panel',
        children: [
          jsx.jsx('div', {
            className: 'qqnt-panel-head',
            children: [
              jsx.jsx('span', { className: 'qqnt-panel-title', children: LABEL }),
              jsx.jsx('span', { className: 'qqnt-panel-meta', children: describe(info) }),
              jsx.jsx('button', {
                className: 'qqnt-panel-btn',
                type: 'button',
                onClick: () => { setStamp(stamp + 1) },
                title: '重新加载内嵌页面',
                children: '刷新',
              }),
              jsx.jsx('button', {
                className: 'qqnt-panel-btn',
                type: 'button',
                onClick: openInBrowser,
                disabled: !(info && info.url),
                children: '在浏览器打开',
              }),
            ],
          }),
          jsx.jsx('div', { className: 'qqnt-panel-body', children: [body] }),
        ],
      })
    }

    /** Global panel body: fetch the address, then hand it to the frame. */
    function ChatExportPanel() {
      const { loading, info, error, reload } = usePanelInfo()
      if (error) {
        return jsx.jsx('div', {
          className: 'qqnt-panel',
          children: [
            jsx.jsx('div', {
              className: 'qqnt-panel-head',
              children: [
                jsx.jsx('span', { className: 'qqnt-panel-title', children: LABEL }),
                jsx.jsx('span', { className: 'qqnt-panel-meta' }),
                jsx.jsx('button', {
                  className: 'qqnt-panel-btn',
                  type: 'button',
                  onClick: reload,
                  children: '重试',
                }),
              ],
            }),
            jsx.jsx('div', {
              className: 'qqnt-panel-body',
              children: [
                jsx.jsx('div', {
                  className: 'qqnt-panel-note',
                  children: [
                    jsx.jsx('p', { className: 'qqnt-panel-error', children: `读取面板信息失败：${error}` }),
                    jsx.jsx('p', {
                      children: '如果 DSH 刚启动，等几秒再点重试；页面本身没有启动时，先把设置里的网页端口改成非 0。',
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      }
      if (loading) {
        return jsx.jsx('div', {
          className: 'qqnt-panel',
          children: [
            jsx.jsx('div', {
              className: 'qqnt-panel-head',
              children: [
                jsx.jsx('span', { className: 'qqnt-panel-title', children: LABEL }),
                jsx.jsx('span', { className: 'qqnt-panel-meta', children: '正在读取…' }),
              ],
            }),
            jsx.jsx('div', { className: 'qqnt-panel-body' }),
          ],
        })
      }
      return jsx.jsx(Frame, { info, reload })
    }

    /** The optional right-column tab: same payload, no chrome of its own. */
    function ChatExportTab() {
      const { loading, info, error, reload } = usePanelInfo()
      if (error) {
        return jsx.jsx('div', {
          className: 'qqnt-panel-note',
          children: [
            jsx.jsx('p', { className: 'qqnt-panel-error', children: `读取面板信息失败：${error}` }),
          ],
        })
      }
      if (loading || !info) {
        return jsx.jsx('div', {
          className: 'qqnt-panel-note',
          children: [jsx.jsx('p', { children: '正在读取…' })],
        })
      }
      return jsx.jsx(Frame, { info, reload })
    }

    // ── cordis plugin entry ──
    const inject = ['slots']

    function apply(ctx) {
      const registerPanel = () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, ChatExportPanel)
      const registerIcon = () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 100,
        label: LABEL,
      }, ChatExportIcon)
      // Declaration-aware on purpose: `slots.inject` waits for the slot to be
      // declared, so load order against ui-sidebar/ui-layout does not matter.
      if (typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('main', registerPanel)
        ctx.slots.inject('sidebar.panellist', registerIcon)
      } else {
        ctx.effect(registerPanel, 'qqnt: main panel')
        ctx.effect(registerIcon, 'qqnt: sidebar icon')
      }

      // Soft dependency: better-sidebar publishes `betterSidebar` only when it
      // is installed and enabled. `ctx.inject` never fires otherwise, so the
      // left-rail panel above keeps working on its own.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['betterSidebar'], (child) => {
          child.effect(() => child.betterSidebar.registerTab({
            id: PANEL_ID,
            title: LABEL,
            description: '在 DSH 里查看与导出本机 QQ 聊天记录',
            icon: (size) => jsx.jsx(ChatExportIcon, { size }),
            order: 100,
            component: ChatExportTab,
          }), 'qqnt: better-sidebar tab')
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
