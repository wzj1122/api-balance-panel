/* 诊断：打包产物用 file:// 加载时，渲染进程的 JS / CSS 到底有没有生效。
 * 用法：electron.exe scripts/diag-renderer.js
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

// 沙箱环境无 GPU，必须彻底禁掉硬件加速，否则 GPU 进程崩溃会直接杀掉整个应用
app.disableHardwareAcceleration()

const TARGET = path.join(__dirname, '..', 'out', 'renderer', 'index.html')

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  })

  win.webContents.on('console-message', (details) => {
    console.log(`[renderer:${details.level}] ${details.message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[did-fail-load] code=${code} desc=${desc}`)
  })

  win.loadFile(TARGET)

  win.webContents.on('did-finish-load', async () => {
    // 等 Vue 挂载
    await new Promise((r) => setTimeout(r, 1500))
    try {
      const res = await win.webContents.executeJavaScript(`
        (() => {
          const appEl = document.getElementById('app')
          const bodyStyle = getComputedStyle(document.body)
          const topbar = document.querySelector('.topbar')
          const btns = document.querySelectorAll('button')
          return JSON.stringify({
            styleSheets: document.styleSheets.length,
            bodyBg: bodyStyle.backgroundColor,
            appChildren: appEl ? appEl.children.length : -1,
            hasTopbar: !!topbar,
            topbarHeight: topbar ? getComputedStyle(topbar).height : 'n/a',
            topbarBg: topbar ? getComputedStyle(topbar).backgroundColor : 'n/a',
            btnCount: btns.length,
            firstBtnBg: btns.length ? getComputedStyle(btns[0]).backgroundColor : 'n/a',
            cssVarGap: getComputedStyle(document.documentElement).getPropertyValue('--gap') || '(空)',
            cssVarPanel: getComputedStyle(document.documentElement).getPropertyValue('--panel') || '(空)'
          }, null, 2)
        })()
      `)
      console.log('===== 渲染进程实测结果 =====')
      console.log(res)
    } catch (e) {
      console.log('[executeJavaScript 失败] ' + e.message)
    }
    setTimeout(() => app.quit(), 300)
  })
}

app.whenReady().then(createWindow)
