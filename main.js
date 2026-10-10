// Qollab entry point. `backend` is pre-created by Qollab from the Select QPU dialog; the Python
// engine receives it as the first argument of every call and never creates one itself.
import * as api from 'engine.api';
import { start } from './ui/app.js';

const bridge = {
  async call(name, kwargs = {}) {
    // .callPromisingKwargs is required on IonQ backends (plain calls fail there)
    const out = await api[name].callPromisingKwargs(backend, kwargs);
    return JSON.parse(out);
  },
};

await start(bridge);
