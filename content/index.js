// Module entry point, imported by content/boot.js on first sight of an
// editable element. The modules communicate through the `LT` object on the
// isolated world's globalThis (boot.js, a classic script, shares it), so the
// import order below is the dependency order.
//
// These files are web_accessible_resources without use_dynamic_url: a dynamic
// URL applies to the entry point only, and the relative imports below would
// resolve back to the static (and therefore blocked) paths. Nothing is lost —
// the injected stylesheet already makes the extension detectable.
import './settings.js';
import './api.js';
import './mirror.js';
import './overlay.js';
import './ce.js';
import './replace.js';
import './popup.js';
import './main.js';
