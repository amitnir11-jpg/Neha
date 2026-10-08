const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/scan.js', 'utf8');
function functionSource(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

test('stalled decoder startup times out and successful startup cancels its timer', async () => {
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({ DECODER_START_TIMEOUT_MS: 8000,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(functionSource('  function decoderStartupTimeout(', '  async function loadZxingLibrary('), context);
  const stalled = context.decoderStartupTimeout(new Promise(() => {}));
  const rejected = assert.rejects(stalled, /decoder startup timed out/);
  [...timers.values()][0]();
  await rejected;
  assert.equal(timers.size, 0);
  assert.equal(await context.decoderStartupTimeout(Promise.resolve('ready')), 'ready');
  assert.equal(timers.size, 0);
});

test('repeated decoder exceptions trigger recovery while undecodable frames keep scanning', async () => {
  for (const fails of [false, true]) {
    const scheduled = [];
    let recoveries = 0;
    let reads = 0;
    const context = vm.createContext({ state: { scanning: true, cameraRunId: 1 }, WASM_MAX_DECODE_WIDTH: 1920,
      ensureWasmReader: async () => ({ readBarcodes: async () => {
        reads++;
        if (fails) throw new Error('WASM runtime failed');
        return [];
      } }),
      document: { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({}) }) }) },
      performance: { now: () => 0 }, console: { warn() {} }, handleDecodeResult() {},
      setTimeout: callback => { scheduled.push(callback); return scheduled.length; } });
    vm.runInContext(functionSource('  async function startWasmDetection(', '  async function enableCameraFocus('), context);
    await context.startWasmDetection({ srcObject: {}, readyState: 2, videoWidth: 1280, videoHeight: 720 }, 1, async () => { recoveries++; });
    await new Promise(resolve => setImmediate(resolve));
    for (let frame = 0; frame < 2; frame++) {
      await scheduled.shift()();
    }
    assert.equal(reads, 3);
    assert.equal(recoveries, fails ? 1 : 0);
    assert.equal(scheduled.length, fails ? 0 : 1);
  }
});

test('a decoder finishing startup after Camera Off never reads or restarts the camera', async () => {
  let ready;
  let reads = 0;
  const state = { scanning: true, cameraRunId: 1 };
  const context = vm.createContext({ state,
    ensureWasmReader: () => new Promise(resolve => { ready = resolve; }) });
  vm.runInContext(functionSource('  async function startWasmDetection(', '  async function enableCameraFocus('), context);
  const startup = context.startWasmDetection({}, 1);
  state.scanning = false;
  state.cameraRunId++;
  ready({ readBarcodes: () => { reads++; } });
  await startup;
  assert.equal(reads, 0);
});

test('native detection keeps scheduling after a temporary video pause', async () => {
  const scheduled = [];
  const state = { nativeDetectorRunning: true, nativeDetectorRunId: 1 };
  const context = vm.createContext({ state, scheduleNativeDetection: (...args) => scheduled.push(args) });
  vm.runInContext(functionSource('  async function detectNativeFrame(', '  async function startNativeDetector('), context);
  const video = { paused: true };
  await context.detectNativeFrame(video, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0][0], video);
  state.nativeDetectorRunning = false;
  await context.detectNativeFrame(video, 1);
  assert.equal(scheduled.length, 1);
});

test('background scanner renders preserve an unsubmitted bin while its field has focus', () => {
  const field = { value: 'CAMERA1' };
  const nodes = { binPanel: { classList: { toggle() {}, remove() {} } }, activeBinLocation: field,
    binPanelMessage: {}, activeBinField: { classList: { toggle() {} } } };
  const document = { activeElement: field };
  const context = vm.createContext({ document, state: { mode: 'INWARD' }, byId: id => nodes[id],
    loadActiveBin: () => '', currentModeInfo: () => ({ requiresBin: true, label: 'Inward' }),
    partFirstMode: () => false, inwardBinReady: () => false });
  vm.runInContext(functionSource('  function renderBinPanel(', '  function ensureActiveBinReady('), context);
  context.renderBinPanel();
  assert.equal(field.value, 'CAMERA1');
  document.activeElement = null;
  context.renderBinPanel();
  assert.equal(field.value, '');
});
