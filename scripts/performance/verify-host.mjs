// Runs the actual MnemoNexus bootstrap in an opaque browser frame. No app-data access.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findChromium, playwright } from '../addon/env.mjs'

const { chromium } = playwright()
const browser = await chromium.launch({ executablePath: findChromium() })
const results = []
try {
  const page = await browser.newPage()
  await page.route('http://localhost:43219/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Laboratory host compatibility</title>' }))
  await page.goto('http://localhost:43219/probe')
  for (const wasm of [false, true]) {
    const source = `import {buildSandboxDocument} from './src/core/extensions/runtime/sandbox/bootstrap.ts'; console.log(buildSandboxDocument(false, ${wasm}));`
    const html = execFileSync('bun', ['--eval', source], { cwd: resolve('../../MnemoNexus'), encoding: 'utf8' })
    const result = await page.evaluate(async ({ html, wasm }) => {
      const code = `void(async()=>{const r={capability:window.mnx.capabilities.includes('wasm-v1'),secure:isSecureContext};const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);try{await WebAssembly.compile(bytes);r.wasm=true}catch{r.wasm=false}try{Function('return 1')();r.eval=true}catch{r.eval=false}try{void parent.document;r.parentDOM=true}catch{r.parentDOM=false}try{localStorage.getItem('x');r.storage=true}catch{r.storage=false}try{const url=URL.createObjectURL(new Blob(['onmessage=async()=>{try{await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));postMessage(true)}catch{postMessage(false)}}'],{type:'application/javascript'}));const worker=new Worker(url);r.worker=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=reject;worker.postMessage(null)});worker.terminate();URL.revokeObjectURL(url)}catch(e){r.workerError=String(e)}try{r.adapter=!!(await navigator.gpu?.requestAdapter())}catch{r.adapter=false}parent.postMessage({probe:r},'*')})()`
      return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Frame probe timed out')) }, 20000)
        const cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', receive); frame.remove() }
        const receive = event => {
          if (event.source !== frame.contentWindow) return
          if (event.data?.kind === 'boot') frame.contentWindow.postMessage({ kind: 'init', protocolVersion: 1, runId: 'probe', code, props: { permissions: wasm ? ['runtime:wasm'] : [], settings: {} }, styles: '', tokens: {} }, '*')
          if (event.data?.probe) { const result = event.data.probe; cleanup(); resolve(result) }
          if (event.data?.kind === 'error') { cleanup(); reject(new Error(event.data.message)) }
        }
        window.addEventListener('message', receive); frame.srcdoc = html; document.body.append(frame)
      })
    }, { html, wasm })
    assert.equal(result.wasm, wasm); assert.equal(result.worker, wasm); assert.equal(result.capability, wasm)
    assert.equal(result.eval, false); assert.equal(result.parentDOM, false); assert.equal(result.storage, false)
    assert.ok(html.includes("connect-src 'none'"))
    results.push({ permission: wasm, ...result })
  }
  mkdirSync('output/performance', { recursive: true })
  const report = { browser: browser.version(), results, scope: 'Actual host bootstrap on Chromium; not native WebView or physical mobile certification.' }
  writeFileSync('output/performance/host-capabilities.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
