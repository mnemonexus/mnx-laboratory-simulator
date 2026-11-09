// Browser acceptance for physical casework, proximity prompts and both look modes.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { playwright, findChromium } from './env.mjs'

mkdirSync('output/playwright', { recursive: true })
const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const checks = [], errors = []
const check = (value, label) => { assert.ok(value, label); checks.push(label); console.log(`PASS ${label}`) }
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', e => errors.push(e.message))
  page.setDefaultTimeout(120000)
  await page.goto(process.env.LAB_URL ?? 'http://127.0.0.1:5173')
  await page.getByTestId('station-sample-prep').click()
  await page.getByTestId('camera-look-mode').waitFor()
  const canvas = page.locator('canvas.lab-canvas')
  const center = async () => {
    const box = await canvas.boundingBox()
    return { x: box.x+box.width/2, y: box.y+box.height/2 }
  }
  const aimStorage = async (kind, preferred = null) => {
    const id = await page.evaluate(({ kind, preferred }) => {
      const w = window.__lab
      const s = preferred ? w.lab.storage.find(s => s.id === preferred) : w.lab.storage.find(s => s.zone === 'main' && s.kind === kind && s.frame.elements[12] > -0.7 && s.frame.elements[12] < 0.2 && s.frame.elements[13] < 0.8 && s.frame.elements[14] < -1)
      const frame = s.frame, local = s.bounds.getCenter(w.player.clone()); local.z = s.bounds.max.z
      const target = local.applyMatrix4(frame)
      target.y = Math.max(target.y, s.frame.elements[13]+0.1)
      const eye = target.clone().add({ x: 0, y: 0, z: 1.05 }); eye.y = 1.4
      w.setMode('walk'); w.setView(eye, target)
      return s.id
    }, { kind, preferred })
    const pos = await center(); await page.mouse.move(pos.x, pos.y)
    await page.getByTestId('environment-prompt').waitFor()
    return id
  }
  const door = await aimStorage('door')
  check(await page.getByTestId('environment-prompt').innerText().then(t => /Cupboard/.test(t) && /Open/.test(t)), 'Nearby cupboard shows an Open prompt')
  await page.mouse.click(...Object.values(await center()))
  await page.waitForFunction(id => window.__lab.lab.storage.find(s => s.id === id).amount === 1, door)
  check(await page.evaluate(id => {
    const s = window.__lab.lab.storage.find(s => s.id === id)
    return s.open && s.instances.every(({ mesh, index }) => {
      const matrix = s.frame.clone(); mesh.getMatrixAt(index, matrix)
      return Math.abs(matrix.elements[0]-s.frame.elements[0]) > 0.1
    })
  }, door), 'Cupboard physically rotates with all material instances')
  await page.screenshot({ path: 'output/playwright/environment-cupboard-open.png' })

  const drawer = await aimStorage('drawer')
  await page.mouse.click(...Object.values(await center()))
  await page.waitForFunction(id => window.__lab.lab.storage.find(s => s.id === id).amount === 1, drawer)
  check(await page.evaluate(id => {
    const s = window.__lab.lab.storage.find(s => s.id === id)
    return s.open && s.instances.every(({ mesh, index }) => {
      const matrix = s.frame.clone(); mesh.getMatrixAt(index, matrix)
      return Math.abs(matrix.elements[14]-s.frame.elements[14]-s.travel) < 0.0001
    })
  }, drawer), 'Drawer slides out with its box and handle')
  check(await page.getByTestId('environment-interact').evaluate(el => {
    const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
    return top === el || el.contains(top)
  }), 'Interaction button stays above existing station overlays')
  await page.screenshot({ path: 'output/playwright/environment-drawer-open.png' })
  await page.getByTestId('environment-interact').click()
  await page.waitForFunction(id => window.__lab.lab.storage.find(s => s.id === id).amount === 0, drawer)
  check(true, 'The on-screen interaction button closes the drawer')
  await page.getByTestId('station-plate-reader').click()
  await page.getByTestId('station-sample-prep').click()
  await page.getByTestId('camera-look-mode').waitFor()
  check(await page.evaluate(({ door, drawer }) => {
    const storage = window.__lab.lab.storage
    return storage.find(s => s.id===door).open && !storage.find(s => s.id===drawer).open
  }, { door, drawer }), 'Storage state survives changing stations')

  const aimMachine = async kind => {
    const id = await page.evaluate(kind => {
      const w = window.__lab, target = w.interactions.targets.find(t => t.zone === 'main' && t.kind === kind)
      const at = target.bounds.getCenter(w.player.clone()), eye = at.clone(); eye.z += kind === 'working plate reader' ? -0.95 : 0.95; eye.y = 1.4
      w.setView(eye, at); return target.id
    }, kind)
    const pos = await center(); await page.mouse.move(pos.x, pos.y)
    await page.getByTestId('environment-prompt').filter({ hasText: kind }).waitFor()
    return id
  }
  const vortex = await aimMachine('vortex mixer')
  await canvas.focus(); await page.keyboard.press('e')
  await page.getByTestId('environment-notice').filter({ hasText: 'Running empty' }).waitFor()
  check(await page.evaluate(id => window.__lab.interactions.machines.isRunning(id), vortex), 'E starts an empty-capable machine with a warning')
  await page.waitForFunction(id => !window.__lab.interactions.machines.isRunning(id), vortex)
  await page.getByTestId('environment-notice').filter({ hasText: 'No mixing' }).waitFor()
  check(true, 'Empty cycle completes with an explicit non-result')
  await aimMachine('working plate reader')
  await canvas.focus(); await page.keyboard.press('e')
  await page.getByTestId('environment-notice').filter({ hasText: 'No sample loaded' }).waitFor()
  check(await page.evaluate(() => !window.__lab.interactions.targets.filter(t => t.kind === 'working plate reader').some(t => window.__lab.interactions.machines.isRunning(t.id))), 'Reader refuses an unconfigured sample read')
  await page.screenshot({ path: 'output/playwright/environment-reader-warning.png' })

  await page.getByTestId('camera-look-mode').selectOption('follow')
  const pos = await center(); await page.mouse.click(pos.x, pos.y)
  const before = await page.evaluate(() => window.__lab.yaw)
  await page.mouse.move(pos.x+70, pos.y+15, { steps: 3 })
  check(await page.evaluate(before => window.__lab.lookActive && Math.abs(window.__lab.yaw-before)>0.05, before), 'Mouse movement turns the camera without holding a button')
  check(await canvas.evaluate(el => getComputedStyle(el).cursor === 'none'), 'Mouse-look hides the cursor')
  check(await canvas.evaluate(el => document.pointerLockElement === el), 'Standalone mouse-look captures the pointer for unlimited turning')
  await page.keyboard.down('Tab')
  await page.waitForFunction(() => !window.__lab.lookActive && !document.pointerLockElement)
  const selector = await page.getByTestId('camera-look-mode').boundingBox()
  await page.mouse.move(selector.x+10,selector.y+10)
  await page.keyboard.up('Tab')
  check(await page.evaluate(() => !window.__lab.lookActive), 'Releasing Tab over a menu keeps the cursor available')
  await page.mouse.move(pos.x,pos.y)
  await page.waitForFunction(() => window.__lab.lookActive)
  check(true, 'Returning to the simulator resumes mouse-look after Tab')
  await page.keyboard.down('Tab')
  await page.waitForFunction(() => !window.__lab.lookActive)
  await page.keyboard.up('Tab')
  await page.waitForFunction(() => window.__lab.lookActive)
  check(true, 'Releasing Tab over the simulator resumes immediately')
  await page.keyboard.press('Escape')
  await page.getByTestId('lab-settings').waitFor()
  check(true, 'Escape opens lab settings')
  await page.screenshot({ path: 'output/playwright/environment-settings.png' })
  const paused = await page.evaluate(() => window.__lab.yaw)
  await page.mouse.move(pos.x+110, pos.y+30)
  check(await page.evaluate(paused => !window.__lab.lookActive && window.__lab.yaw===paused, paused), 'Escape releases follow mode for UI use')
  await page.getByTestId('camera-look-mode').selectOption('drag')
  await page.getByTestId('resume-lab').click()
  const dragBefore = await page.evaluate(() => window.__lab.yaw)
  await page.mouse.move(pos.x, pos.y)
  check(await page.evaluate(yaw => window.__lab.yaw===yaw, dragBefore), 'Hold-and-drag mode ignores unpressed mouse movement')
  await page.mouse.down(); await page.mouse.move(pos.x+80,pos.y,{steps:3}); await page.mouse.up()
  check(await page.evaluate(yaw => Math.abs(window.__lab.yaw-yaw)>0.05, dragBefore), 'Hold-and-drag mode still turns while pressed')

  // Right mouse is an in-game control (look closer), never the browser's menu:
  // a menu took the key release and left the player walking.
  await page.evaluate(() => { window.__menus = []; window.addEventListener('contextmenu', e => window.__menus.push(e.defaultPrevented)) })
  await page.mouse.move(pos.x, pos.y); await canvas.focus()
  await page.keyboard.down('w')
  await page.mouse.down({ button: 'right' })
  await page.waitForFunction(() => window.__lab.camera.fov < 30)
  check(await page.evaluate(() => window.__lab.pressed.has('w')), 'Holding right mouse looks closer without interrupting walking')
  await page.mouse.up({ button: 'right' })
  check(await page.evaluate(() => window.__menus.length > 0 && window.__menus.every(Boolean)), 'Right-clicking the scene opens no browser menu')
  await page.waitForFunction(() => window.__lab.camera.fov === 52)
  check(true, 'Releasing right mouse returns to the normal view')
  await page.keyboard.up('w')
  check(await page.evaluate(() => window.__lab.pressed.size === 0), 'Movement stops on key release after a right-click')
  await canvas.focus(); await page.keyboard.down('w')
  await page.evaluate(() => document.querySelector('label[for=camera-look-mode]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  check(await page.evaluate(() => window.__lab.pressed.size === 0), 'A browser menu opened over the interface stops held movement')
  await page.keyboard.up('w')
  const turn = async () => {
    const yaw = await page.evaluate(() => window.__lab.yaw)
    await page.mouse.move(pos.x, pos.y); await page.mouse.down(); await page.mouse.move(pos.x+80, pos.y, { steps: 3 }); await page.mouse.up()
    return Math.abs(await page.evaluate(() => window.__lab.yaw) - yaw)
  }
  const normalTurn = await turn()
  await page.mouse.down({ button: 'right' })
  await page.waitForFunction(() => window.__lab.closer === 1)
  const closerTurn = await turn()
  check(await page.evaluate(() => !window.__lab.looking && window.__lab.closerHeld), 'Dragging while looking closer ends with the left button')
  check(closerTurn > 0 && closerTurn < normalTurn * 0.6, 'Looking closer slows turning to match the magnification')
  await page.mouse.up({ button: 'right' })
  await page.waitForFunction(() => window.__lab.camera.fov === 52)

  await page.evaluate(() => {
    const w = window.__lab; w.setView({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 1.4, z: 1 })
  })
  await page.mouse.move(pos.x, pos.y)
  await page.getByTestId('environment-prompt').waitFor({ state: 'hidden' })
  check(true, 'Prompts clear when no reachable target is under the cursor')
  await page.setViewportSize({ width: 760, height: 820 })
  await page.screenshot({ path: 'output/playwright/environment-compact.png' })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: 'output/playwright/environment-dark.png' })
  check(await page.getByTestId('camera-look-mode').evaluate(el => {
    const r = el.getBoundingClientRect(), at = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
    return r.x>=0 && r.right<=innerWidth && (at===el || el.contains(at))
  }), 'Look-mode selector remains reachable in a compact viewport')

  // A sandboxed add-on cannot request pointer lock. Exercise the fallback in
  // an iframe without allow-pointer-lock, including the original edge failure.
  const embedded = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  embedded.setDefaultTimeout(120000)
  embedded.on('pageerror', e => errors.push(e.message))
  // Use a real same-origin wrapper. about:blank makes standalone IndexedDB
  // third-party storage, which can remain pending under browser storage policy.
  // The sandbox still excludes pointer lock; opaque real-host coverage is separate.
  const labUrl = process.env.LAB_URL ?? 'http://127.0.0.1:5173'
  const wrapperUrl = new URL('/__environment_embed__', labUrl).href
  await embedded.route(wrapperUrl, route => route.fulfill({ contentType: 'text/html', body: `<iframe id="lab" sandbox="allow-scripts allow-same-origin" src="${labUrl}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>` }))
  await embedded.goto(wrapperUrl)
  const frame = embedded.frameLocator('#lab')
  await frame.getByTestId('station-sample-prep').click()
  await frame.getByTestId('camera-look-mode').waitFor()
  await frame.getByTestId('camera-look-mode').selectOption('follow')
  const embeddedCanvas = frame.locator('canvas.lab-canvas')
  const embeddedBox = await embeddedCanvas.boundingBox()
  await embedded.mouse.click(embeddedBox.x+embeddedBox.width/2,embeddedBox.y+embeddedBox.height/2)
  check(await embeddedCanvas.evaluate(el => !document.pointerLockElement && window.__lab.lookActive && getComputedStyle(el).cursor==='none'), 'Embedded mouse-look stays active with a hidden cursor without requesting forbidden pointer lock')
  await embedded.mouse.move(embeddedBox.x+embeddedBox.width-2,embeddedBox.y+embeddedBox.height/2)
  const edgeYaw = await embeddedCanvas.evaluate(() => window.__lab.yaw)
  await embeddedCanvas.evaluate(() => new Promise(resolve => setTimeout(resolve,700)))
  check(await embeddedCanvas.evaluate((el, yaw) => window.__lab.lookActive && Math.abs(window.__lab.yaw-yaw)>0.01 && document.activeElement===el, edgeYaw), 'Embedded mouse-look keeps turning and retains keyboard focus at the viewport edge')
  await embedded.keyboard.down('Tab')
  const embeddedSelect = await frame.getByTestId('camera-look-mode').boundingBox()
  await embedded.mouse.move(embeddedSelect.x+12,embeddedSelect.y+10)
  await embedded.keyboard.up('Tab')
  check(await embeddedCanvas.evaluate(() => !window.__lab.lookActive), 'Embedded Tab release over a menu retains the cursor')
  await embedded.mouse.move(embeddedBox.x+embeddedBox.width/2,embeddedBox.y+embeddedBox.height/2)
  await embeddedCanvas.evaluate(() => new Promise(resolve => setTimeout(resolve,150)))
  check(await embeddedCanvas.evaluate(() => window.__lab.lookActive), 'Embedded mouse-look resumes on returning to the scene')
  const labFrame = embedded.frames().find(f => f !== embedded.mainFrame())
  await labFrame.evaluate(() => { window.__menus = []; window.addEventListener('contextmenu', e => window.__menus.push(e.defaultPrevented)) })
  await embedded.mouse.down({ button: 'right' })
  await labFrame.waitForFunction(() => window.__lab.camera.fov < 30 && window.__lab.lookActive)
  await embedded.mouse.up({ button: 'right' })
  await labFrame.waitForFunction(() => window.__lab.camera.fov === 52)
  check(await labFrame.evaluate(() => window.__lab.lookActive && window.__menus.length > 0 && window.__menus.every(Boolean)), 'Embedded right mouse looks closer on the capture surface with no browser menu')
  await embedded.keyboard.press('Escape')
  await frame.getByTestId('lab-settings').waitFor()
  check(true, 'Embedded Escape opens settings and releases the cursor')
  await embedded.close()
  check(errors.length===0, 'No browser runtime errors')
  const debug = await page.evaluate(() => window.__lab.debugInfo())
  writeFileSync('output/playwright/environment-verification.json', JSON.stringify({ checks, debug, errors }, null, 2))
  console.log(`${checks.length} environment checks passed`)
} finally { await browser.close() }
