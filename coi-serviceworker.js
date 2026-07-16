/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  // ---- SERVICE WORKER CONTEXT ---
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) =>
    event.waitUntil(self.clients.claim())
  );
  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });
  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    const request =
      coepCredentialless && r.mode === "no-cors"
        ? new Request(r, { credentials: "omit" })
        : r;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp"
          );
          if (!coepCredentialless) {
            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          }
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  // ---- WINDOW CONTEXT ---
  (() => {
    if (window.crossOriginIsolated !== false) return;
    let coi = {
      shouldRegister: () => true,
      shouldDeregister: () => false,
      coepCredentialless: () =>
        !(window.chrome === undefined && window.netscape === undefined),
      coepDegrade: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };
    const n = navigator;
    const controlling = n.serviceWorker && n.serviceWorker.controller;
    // Send the coepCredentialless setting to the SW.
    if (controlling) {
      n.serviceWorker.controller.postMessage({
        type: "coepCredentialless",
        value: coi.coepCredentialless(),
      });
      if (coi.shouldDeregister()) {
        n.serviceWorker.controller.postMessage({ type: "deregister" });
      }
    }
    // If we're already controlled but still not isolated, the SW is stale.
    if (controlling && !window.crossOriginIsolated) {
      window.sessionStorage.removeItem("coiReloadedBySelf");
    }
    if (!coi.shouldRegister()) return;
    if (!window.isSecureContext) {
      !coi.quiet &&
        console.log("COOP/COEP SW not registered: insecure context.");
      return;
    }
    // CRITICAL: the updatefound listener is what makes first-load work.
    n.serviceWorker
      .register(window.document.currentScript.src)
      .then(
        (registration) => {
          !coi.quiet &&
            console.log("COOP/COEP SW registered", registration.scope);
          registration.addEventListener("updatefound", () => {
            !coi.quiet &&
              console.log(
                "Reloading page to make use of updated COOP/COEP SW."
              );
            coi.doReload();
          });
          // If the SW is active but not controlling this page, reload once.
          if (registration.active && !n.serviceWorker.controller) {
            !coi.quiet &&
              console.log("Reloading page to make use of COOP/COEP SW.");
            coi.doReload();
          }
        },
        (err) => {
          !coi.quiet && console.error("COOP/COEP SW failed to register:", err);
        }
      );
  })();
}

/* =============================================================================
   PWA OFFLINE CACHE  (v8)
   -----------------------------------------------------------------------------
   The SW was already here for COOP/COEP. Extend it to cache the app shell and
   the ~30MB wasm core, so the whole thing is INSTALLABLE and works with NO
   NETWORK AT ALL. A local-first media editor that needs no network is rare.

   Strategy: cache-first for the shell and the core (they're version-pinned and
   never change), network-first for everything else.
   ========================================================================== */

const CACHE = 'ffmpeg-studio-v8';
const SHELL = [
  './', './index.html', './style.css',
  './app.js', './pipeline.js', './workflows.js', './workflows_v3.js', './agents.js',
  './webgl-preview.js', './beat-detection.js',
  './storage.js', './waveform.js', './analysis.js', './tools.js',
  './tripcam.js', './tripcam-ui.js',
  './hwaccel.js', './opfs.js', './datamosh.js', './nodegraph.js',
  './manifest.json', './icon-192.png', './icon-512.png',
  './vendor/ffmpeg.js', './vendor/814.ffmpeg.js', './vendor/util.js',
  './vendor/st/ffmpeg-core.js', './vendor/st/ffmpeg-core.wasm',
];

if (typeof window === 'undefined' && typeof self !== 'undefined' && self.registration) {
  self.addEventListener('install', (e) => {
    e.waitUntil(
      caches.open(CACHE)
        // Don't let one 404 abort the whole precache.
        .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
        .then(() => self.skipWaiting())
    );
  });

  self.addEventListener('activate', (e) => {
    e.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim())
    );
  });
}
