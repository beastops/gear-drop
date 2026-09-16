/**
 * What this browser can actually do.
 *
 * Every entry here is a real behavioural difference between platforms, checked once and
 * used to change what the interface offers rather than to let something fail silently.
 * Feature detection wherever it works; the two places it does not are marked, because a
 * user-agent test is a liability and should have to justify itself.
 */

/**
 * iOS and iPadOS, including an iPad reporting itself as a Mac.
 *
 * Used for exactly two things, both of which are APIs that *exist* on the platform and do
 * not work: `<input webkitdirectory>` accepts the attribute and then never returns a
 * directory, and an `<a download>` pointing at a blob opens the file instead of saving it.
 * Neither can be feature-detected, and getting them wrong means a control that does nothing.
 */
function isApplePhoneOrTablet() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports a desktop Mac UA; a Mac with a touchscreen does not exist.
  const iPadAsMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  return iOS || iPadAsMac;
}

let cached = null;

export function platform() {
  if (cached) return cached;

  const apple = isApplePhoneOrTablet();
  const hasWindow = typeof window !== 'undefined';

  cached = {
    apple,

    /** Real peer-to-peer at all. Without it the app has nothing to offer. */
    webrtc: hasWindow && typeof RTCPeerConnection === 'function',

    /** The user picks a location and bytes stream straight there. Chromium only. */
    filePicker: hasWindow && typeof window.showSaveFilePicker === 'function',

    /** Private origin storage, so a large file never has to sit in memory. */
    opfs: typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory,

    /**
     * Sending a whole folder. Safari accepts the attribute and returns nothing, so the
     * control has to be hidden there rather than offered and then quietly failing.
     */
    folders: hasWindow && 'webkitdirectory' in HTMLInputElement.prototype && !apple,

    /**
     * Whether a finished file can be handed over without asking the person to tap again.
     * On iOS an `<a download>` with a blob opens the file in a viewer instead of saving it,
     * so the app offers an explicit Save that goes through the system share sheet.
     */
    autoSave: !apple,

    /** The share sheet, which is how a file reaches Files, Photos or another app on iOS. */
    shareFiles: typeof navigator !== 'undefined' && typeof navigator.canShare === 'function',

    /** Stops a phone suspending a transfer it is in the middle of. */
    wakeLock: typeof navigator !== 'undefined' && !!navigator.wakeLock,

    /** On iOS this exists only once the app has been added to the Home Screen. */
    notifications: hasWindow && 'Notification' in window,

    /** Chromium prompts to install; everyone else does it from a browser menu. */
    installPrompt: hasWindow && 'onbeforeinstallprompt' in window,

    /** Drag and drop is a pointer-and-keyboard idea. */
    dragAndDrop: hasWindow && !('ontouchstart' in window && !matchMedia('(hover: hover)').matches),

    /** Off-thread rendering for the radar. */
    offscreenCanvas: hasWindow && typeof OffscreenCanvas === 'function',
  };
  return cached;
}

/**
 * Hand a file to the browser's own downloader.
 *
 * The revoke is deliberately late. Releasing the object URL as soon as the click returns can
 * cancel a download the browser has not actually started yet, and the cost of holding it is
 * one entry until the page goes.
 *
 * @param {File|Blob} file
 * @param {string} name
 * @param {Function} [after] run once the URL is released, for anything the file was using
 */
export function downloadBlob(file, name, after) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    after?.();
  }, 60_000);
}

/**
 * Hand a finished file to the person, from inside a gesture.
 *
 * The share sheet first where it exists, because on a phone that is how a file reaches
 * Files, Photos or another app. A download link otherwise.
 */
export async function saveFile(result) {
  const p = platform();
  if (p.shareFiles && result.file && navigator.canShare({ files: [result.file] })) {
    try {
      await navigator.share({ files: [result.file] });
      return 'shared';
    } catch (err) {
      // Cancelling the share sheet is a choice, not a failure.
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }

  downloadBlob(result.file, result.name);
  return 'downloaded';
}
