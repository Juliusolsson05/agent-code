const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
app.disableHardwareAcceleration()
const html = fs.readFileSync(path.join(__dirname, '__dlg.html'), 'utf8')
app.whenReady().then(async () => {
  const results = []
  for (const [w, h] of [[1440, 900], [1280, 700], [900, 500], [800, 380]]) {
    const win = new BrowserWindow({ width: w, height: h, show: false })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const r = await win.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('content')
      const b = document.getElementById('body')
      const cr = c.getBoundingClientRect()
      return {
        viewport: innerHeight,
        contentH: Math.round(cr.height),
        contentTop: Math.round(cr.top),
        contentBottom: Math.round(cr.bottom),
        bodyClientH: b.clientHeight,
        bodyScrollH: b.scrollHeight,
        bodyScrolls: b.scrollHeight > b.clientHeight + 1,
        overflowsViewport: cr.top < -0.5 || cr.bottom > innerHeight + 0.5,
      }
    })()`)
    results.push({ win: w + 'x' + h, ...r })
    win.destroy()
  }
  console.log('RESULTS ' + JSON.stringify(results))
  app.quit()
}).catch(e => { console.log('ERR ' + e.message); app.quit() })
