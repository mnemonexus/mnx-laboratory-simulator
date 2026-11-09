// `npm run dev` / `npm run build`: install the stand-in host, then start the
// lab exactly as MnemoNexus would. Imports run in order.
import './mockHost'
import '../src/main'
import { DEV } from '../src/env'

// Standalone build only. Add-on frames never register a service worker.
if (!DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(new URL('./sw.js', document.baseURI)).catch(error => console.warn('Offline installation unavailable:', error))
}
