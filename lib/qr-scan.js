// Read QR codes from the camera. Used by the nearby-device panel, which needs
// the code the other device shows.
//
// BarcodeDetector where the browser has it (Chromium on macOS and Android),
// otherwise the vendored jsQR on canvas frames: Firefox, Safari and desktop
// Chromium elsewhere have no detector. jsQR is 250 KB, so it is fetched only
// when a scan starts there. Frames are polled on a timer, not on animation
// frames, which a background tab stops delivering.

const INTERVAL = 200
const MAX_SIDE = 640 // jsQR's cost grows with pixels; a pairing code is large on screen

async function detector() {
  const {BarcodeDetector} = globalThis
  if (typeof BarcodeDetector === 'function') {
    try {
      if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        const native = new BarcodeDetector({formats: ['qr_code']})
        return async (video) => (await native.detect(video))[0]?.rawValue ?? null
      }
    } catch {
      // A detector that throws is no detector: fall through to jsQR.
    }
  }
  // jsQR is a UMD bundle: imported for its side effect, it sets self.jsQR.
  await import('../vendor/jsqr/jsQR.js')
  const decode = globalThis.jsQR
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', {willReadFrequently: true})
  return (video) => {
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.round(video.videoWidth * scale)
    const height = Math.round(video.videoHeight * scale)
    if (!width || !height) return null
    canvas.width = width
    canvas.height = height
    context.drawImage(video, 0, 0, width, height)
    return decode(context.getImageData(0, 0, width, height).data, width, height)?.data ?? null
  }
}

/**
 * Show the camera in `video` and call `onText` with every code it reads.
 *
 * @param {HTMLVideoElement} video
 * @param {(text: string) => void} onText
 * @returns {Promise<() => void>} stops the camera
 * @throws {Error} with a message for the reader when there is no camera to use
 */
export async function startScan(video, onText) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot use the camera here. Paste the code instead.')
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}, audio: false})
  } catch {
    throw new Error('The camera is blocked or missing. Paste the code instead.')
  }

  let stopped = false
  let timer = 0
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  try {
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    const detect = await detector()
    const tick = async () => {
      if (stopped) return
      try {
        const text = await detect(video)
        if (text && !stopped) onText(text)
      } catch {
        // One unreadable frame says nothing about the next.
      }
      if (!stopped) timer = setTimeout(tick, INTERVAL)
    }
    void tick()
  } catch {
    stop()
    throw new Error('The camera could not start. Paste the code instead.')
  }
  return stop
}
