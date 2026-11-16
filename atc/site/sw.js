// Deliberately does nothing. ATC Explorer is served under SkyFrame's Pages site, and
// SkyFrame's service worker (web/sw.js, scope "/Skyframe2/") answers every same-origin
// GET cache-first. Without a more specific registration it would also capture /atc/
// and pin this app's code and weekly-refreshed data to whatever it cached first.
// Registering this worker at the /atc/ scope takes those requests away from it; with
// no fetch handler, they go straight to the network. Same trick HoofCast relies on.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
