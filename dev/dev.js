// Dev entry point: same app, engine reached over HTTP (dev/serve.py) instead of Pyodide.
import { start } from '../ui/app.js';

start({
  async call(name, kwargs = {}) {
    const r = await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(kwargs) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
}).catch((e) => console.error(e));
