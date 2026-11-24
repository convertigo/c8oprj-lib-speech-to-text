// lib_SpeechToText_ui_ngx page-side engine, loaded with import() by the speechToText_sc component and the shared
// actions. One engine per browser tab (window.__c8oSpeechToText): one worker, one model, one microphone capture,
// whatever the number of components on the pages.
//
//   const { speechToText } = await import(libUrl + 'stt-engine.js');
//   const stt = speechToText();
//   const off = stt.on((e) => { ... });   // every event, see emit() below
//   await stt.load({ model: 'auto', language: '', task: 'transcribe', modelsUrl: '' });   // '' = language of the browser
//   await stt.start(ownerId, { micProcessing: true });  …  stt.stop();
//
// Events: {type:'state', state} after every change, {type:'ready', model, device, reason, loadMs, language, task},
// {type:'partial', owner, text}, {type:'final', owner, text}, {type:'done', owner}, {type:'error', owner, message},
// {type:'stats', kind, ms, audioS}. state = {status, ready, loading, listening, finishing, speaking, level, model,
// device, reason, loadMs, progress, owner, error, language ('auto' when detected), task}.

const LIB_URL = new URL('./', import.meta.url).href;

// ISO 639-1 codes of the languages Whisper knows best, to their Whisper names
const LANGS = {
	en: 'english', fr: 'french', es: 'spanish', de: 'german', it: 'italian', pt: 'portuguese', nl: 'dutch', pl: 'polish',
	ru: 'russian', uk: 'ukrainian', cs: 'czech', sk: 'slovak', ro: 'romanian', hu: 'hungarian', el: 'greek', bg: 'bulgarian',
	hr: 'croatian', sr: 'serbian', sl: 'slovenian', sv: 'swedish', da: 'danish', no: 'norwegian', nb: 'norwegian',
	nn: 'nynorsk', fi: 'finnish', et: 'estonian', lv: 'latvian', lt: 'lithuanian', ca: 'catalan', eu: 'basque',
	gl: 'galician', tr: 'turkish', ar: 'arabic', he: 'hebrew', fa: 'persian', hi: 'hindi', ur: 'urdu', bn: 'bengali',
	ta: 'tamil', ja: 'japanese', zh: 'chinese', ko: 'korean', vi: 'vietnamese', th: 'thai', id: 'indonesian',
	ms: 'malay', tl: 'tagalog', sw: 'swahili', af: 'afrikaans',
};

// Spoken language given to Whisper: a Whisper name ('french') or an ISO code ('fr', 'fr-FR') as given; 'auto' to let
// Whisper detect it at each pass; empty: the first language of the browser that Whisper knows (detection otherwise).
// Detection on short pieces of speech often takes an accent for English and then writes English, so it is opt-in.
function resolveLanguage(value) {
	const v = (value === undefined || value === null ? '' : String(value)).trim().toLowerCase();
	if (v === 'auto') {
		return '';
	}
	if (!v) {
		const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || [];
		for (const l of prefs) {
			const name = LANGS[String(l || '').toLowerCase().split(/[-_]/)[0]];
			if (name) {
				return name;
			}
		}
		return '';
	}
	return LANGS[v.split(/[-_]/)[0]] || v;
}

// <server>/convertigo/projects/<model project>/DisplayObjects/models/ next to this library
function defaultModelUrl(project) {
	const i = LIB_URL.indexOf('/projects/');
	const root = i > 0 ? LIB_URL.substring(0, i) : new URL('../../..', LIB_URL).href.replace(/\/$/, '');
	return root + '/projects/' + project + '/DisplayObjects/models/';
}

function withSlash(url) {
	return url.endsWith('/') ? url : url + '/';
}

class SpeechToTextEngine {
	constructor() {
		this.listeners = new Set();
		this.worker = null;
		this.config = null;
		this.readyPromise = null;
		this.ctx = null;
		this.stream = null;
		this.node = null;
		this.source = null;
		this.state = {
			status: 'idle', ready: false, loading: false, listening: false, finishing: false, speaking: false, level: 0,
			model: '', device: '', reason: '', loadMs: 0, progress: 0, owner: null, error: '', language: '', task: 'transcribe',
		};
	}

	on(listener) {
		this.listeners.add(listener);
		listener({ type: 'state', state: { ...this.state } });
		return () => this.listeners.delete(listener);
	}

	emit(event) {
		for (const l of [...this.listeners]) {
			try {
				l(event);
			} catch (e) {
				console.error('[speechToText] listener', e);
			}
		}
	}

	setState(patch) {
		Object.assign(this.state, patch);
		this.emit({ type: 'state', state: { ...this.state } });
	}

	// Loads the model (once per configuration). Options: model 'auto'|'base'|'small', language (see resolveLanguage:
	// Whisper name, ISO code, 'auto' to detect it, empty for the language of the browser), task ('transcribe' writes in
	// the spoken language, 'translate' writes English), modelsUrl (folder holding onnx-community/<model>/ for both models; empty: the model
	// projects deployed on this server). Resolves with the ready event.
	load(options = {}) {
		const model = options.model || 'auto';
		const language = resolveLanguage(options.language);
		const task = options.task === 'translate' ? 'translate' : 'transcribe';
		// absolute URL: the worker (and transformers.js) cannot resolve a path relative to the page
		const modelsUrl = options.modelsUrl ? withSlash(new URL(String(options.modelsUrl), document.baseURI).href) : '';
		const key = JSON.stringify([model, language, task, modelsUrl]);
		if (this.config === key && this.readyPromise) {
			return this.readyPromise;
		}
		this.stop(true);
		if (this.worker) {
			this.worker.terminate();
		}
		this.config = key;
		this.setState({ status: 'loading', ready: false, loading: true, model: '', device: '', reason: '', loadMs: 0, progress: 0, error: '', language: language || 'auto', task });
		const worker = new Worker(LIB_URL + 'stt-worker.js', { type: 'module' });
		this.worker = worker;
		this.readyPromise = new Promise((resolve, reject) => {
			worker.onmessage = (ev) => this.onWorker(ev.data, resolve, reject);
			worker.onerror = (e) => {
				const message = 'Speech-to-text worker failed: ' + (e && e.message ? e.message : 'cannot load ' + LIB_URL + 'stt-worker.js');
				this.setState({ status: 'error', loading: false, error: message });
				this.emit({ type: 'error', owner: this.state.owner, message });
				reject(new Error(message));
			};
		});
		this.readyPromise.catch(() => {
			if (this.worker === worker) {
				this.config = null;
				this.readyPromise = null;
			}
		});
		worker.postMessage({
			type: 'init', model, language, task,
			modelUrls: {
				base: modelsUrl || defaultModelUrl('lib_SpeechToText_model_whisperBase'),
				small: modelsUrl || defaultModelUrl('lib_SpeechToText_model_whisperSmall'),
			},
		});
		return this.readyPromise;
	}

	onWorker(m, resolve, reject) {
		const owner = this.state.owner;
		switch (m.type) {
			case 'progress':
				this.setState({ progress: m.total ? Math.round(m.loaded * 100 / m.total) : 0 });
				break;
			case 'ready': {
				const ready = { type: 'ready', model: m.model, device: m.device, reason: m.reason, loadMs: m.ms, language: this.state.language, task: this.state.task };
				this.setState({ status: 'ready', ready: true, loading: false, model: m.model, device: m.device, reason: m.reason, loadMs: m.ms, progress: 100 });
				this.emit(ready);
				resolve(ready);
				break;
			}
			case 'level':
				this.setState({ speaking: m.speaking, level: m.level, status: this.state.listening ? (m.speaking ? 'speaking' : 'listening') : this.state.status });
				break;
			case 'partial':
				this.emit({ type: 'partial', owner, text: m.text });
				break;
			case 'final':
				this.emit({ type: 'final', owner, text: m.text });
				break;
			case 'stats':
				this.emit({ type: 'stats', kind: m.kind, ms: m.ms, audioS: m.audioS });
				break;
			case 'done':
				this.setState({ finishing: false, status: 'ready' });
				this.emit({ type: 'done', owner });
				break;
			case 'error':
				if (!this.state.ready) {
					this.setState({ status: 'error', loading: false, error: m.message });
					reject(new Error(m.message));
				} else {
					this.setState({ finishing: false, error: m.message });
				}
				this.emit({ type: 'error', owner, message: m.message });
				break;
		}
	}

	// Starts the microphone for owner (any id: the component or action that asked). Loads the model first when needed.
	// options.micProcessing false turns off the echo cancellation, noise suppression and gain control of the browser.
	async start(owner, options = {}) {
		if (this.state.listening) {
			this.stop(false);
		}
		if (!this.readyPromise) {
			this.load(options);
		}
		await this.readyPromise;
		const processing = options.micProcessing !== false;
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing },
			});
			const AC = window.AudioContext || window.webkitAudioContext;
			this.ctx = new AC();
			await this.ctx.resume();
			this.source = this.ctx.createMediaStreamSource(this.stream);
			const worker = this.worker;
			const send = (samples) => worker.postMessage({ type: 'audio', samples }, [samples.buffer]);
			if (this.ctx.audioWorklet) {
				await this.ctx.audioWorklet.addModule(LIB_URL + 'stt-capture-worklet.js');
				this.node = new AudioWorkletNode(this.ctx, 'stt-capture');
				this.node.port.onmessage = (e) => send(e.data);
			} else {
				// old browsers: ScriptProcessor and a plain decimation to 16 kHz
				const ratio = this.ctx.sampleRate / 16000;
				let pos = 0;
				this.node = this.ctx.createScriptProcessor(4096, 1, 1);
				this.node.onaudioprocess = (e) => {
					const input = e.inputBuffer.getChannelData(0);
					const out = [];
					for (; pos < input.length; pos += ratio) {
						out.push(input[Math.floor(pos)]);
					}
					pos -= input.length;
					send(Float32Array.from(out));
				};
			}
			this.source.connect(this.node);
			// a muted output keeps the node running in every browser
			const mute = this.ctx.createGain();
			mute.gain.value = 0;
			this.node.connect(mute);
			mute.connect(this.ctx.destination);
			this.setState({ listening: true, finishing: false, owner, status: 'listening', error: '' });
		} catch (e) {
			this.release();
			const message = 'Microphone unavailable: ' + (e && e.message ? e.message : e);
			this.setState({ listening: false, status: 'error', error: message });
			this.emit({ type: 'error', owner, message });
			throw new Error(message);
		}
	}

	release() {
		try { this.node && this.node.disconnect(); } catch (e) { /* closed */ }
		try { this.source && this.source.disconnect(); } catch (e) { /* closed */ }
		try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* stopped */ }
		try { this.ctx && this.ctx.close(); } catch (e) { /* closed */ }
		this.node = this.source = this.stream = this.ctx = null;
	}

	// Stops the microphone. Unless quiet, the worker transcribes what was said last, then emits 'done'.
	stop(quiet) {
		const was = this.state.listening;
		this.release();
		if (!was) {
			return;
		}
		if (!quiet && this.worker) {
			this.setState({ listening: false, speaking: false, level: 0, finishing: true, status: 'finishing' });
			this.worker.postMessage({ type: 'flush' });
		} else {
			this.setState({ listening: false, speaking: false, level: 0, status: this.state.ready ? 'ready' : this.state.status });
		}
	}
}

export function speechToText() {
	if (!window.__c8oSpeechToText) {
		window.__c8oSpeechToText = new SpeechToTextEngine();
	}
	return window.__c8oSpeechToText;
}

export const libUrl = LIB_URL;
export { resolveLanguage };
