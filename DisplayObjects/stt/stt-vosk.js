// Vosk engine of lib_SpeechToText_ui_ngx: Kaldi streaming recognition on WebAssembly (vosk-browser 0.0.8, which runs
// the recognizer in its own Web Worker). Lighter than Whisper on slow devices and truly streaming (no repeated
// passes), but less accurate, one model per language, and the text comes without capitals or punctuation.
//
// createVoskWorker() returns an object that speaks the protocol of stt-worker.js (postMessage / onmessage /
// terminate), so the engine drives Whisper and Vosk the same way:
// In:  {type:'init', language, task, modelsUrl, projectsUrl} | {type:'audio', samples} | {type:'flush'} | {type:'live', mode}
// Out: {type:'progress'} | {type:'ready'} | {type:'partial'} | {type:'final'} | {type:'level'} | {type:'done'} | {type:'error'}

// Vosk models by Whisper language name: model project and archive inside its DisplayObjects/models/ folder
const VOSK_MODELS = {
	french: { project: 'lib_SpeechToText_model_voskSmallFr', path: 'vosk/vosk-model-small-fr-0.22.tar.gz', label: 'Vosk small French' },
};

const SR = 16000;

let voskScript = null;

// vosk-browser is a UMD bundle: a script tag defines window.Vosk (its worker comes from a blob, so it works from
// another origin too)
function loadVosk(libUrl) {
	if (window.Vosk) {
		return Promise.resolve(window.Vosk);
	}
	if (!voskScript) {
		voskScript = new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = libUrl + 'lib/vosk.js';
			script.onload = () => (window.Vosk ? resolve(window.Vosk) : reject(new Error('vosk.js did not define Vosk')));
			script.onerror = () => reject(new Error('Cannot load ' + script.src));
			document.head.appendChild(script);
		});
		voskScript.catch(() => { voskScript = null; });
	}
	return voskScript;
}

// true when the archive answers at url. A Convertigo server answers 200 with a JSON error for a missing file, so
// the check reads the first bytes: a .tar.gz starts with the gzip magic number 1f 8b.
async function archiveAvailable(url) {
	try {
		const r = await fetch(url, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' });
		if (!r.ok) {
			return false;
		}
		const reader = r.body.getReader();
		const { value } = await reader.read();
		reader.cancel().catch(() => { /* done */ });
		return !!value && value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b;
	} catch (e) {
		return false;
	}
}

function tidy(text) {
	const t = String(text || '').replace(/\s+/g, ' ').trim();
	return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

export function createVoskWorker(libUrl) {
	const adapter = {
		onmessage: null,
		onerror: null,
		model: null,
		recognizer: null,
		live: true,
		lastPartial: '',
		flushing: false,
		flushTimer: null,
		// voice activity for the level meter and the speaking state (Vosk itself needs no detector)
		noise: 0.003,
		speaking: false,
		silenceMs: 0,
		levelTick: 0,
		post(data) {
			if (this.onmessage) {
				this.onmessage({ data });
			}
		},
		async init(data) {
			const t0 = performance.now();
			if (data.task === 'translate') {
				throw new Error('Vosk only transcribes: use a Whisper model to translate to English.');
			}
			const spec = VOSK_MODELS[data.language];
			if (!spec) {
				const known = Object.keys(VOSK_MODELS).join(', ');
				throw new Error('No Vosk model for the language "' + (data.language || 'auto') + '": Vosk needs a language set, available: ' + known + '.');
			}
			const url = (data.modelsUrl || data.projectsUrl + spec.project + '/DisplayObjects/models/') + spec.path;
			const Vosk = await loadVosk(libUrl);
			if (!(await archiveAvailable(url))) {
				throw new Error('Model not found at ' + url + ': deploy the project ' + spec.project + ' on the server, or set modelsUrl.');
			}
			this.post({ type: 'progress', loaded: 0, total: 1 });
			let model;
			try {
				model = await Vosk.createModel(url);
			} catch (e) {
				throw new Error('Cannot load the Vosk model ' + url + (e && e.message ? ': ' + e.message : ''));
			}
			this.model = model;
			this.recognizer = new model.KaldiRecognizer(SR);
			this.recognizer.on('partialresult', (m) => {
				const text = tidy(m.result && m.result.partial);
				if (this.live && text && text !== this.lastPartial) {
					this.lastPartial = text;
					this.post({ type: 'partial', text });
				}
			});
			this.recognizer.on('result', (m) => {
				const text = tidy(m.result && m.result.text);
				this.lastPartial = '';
				if (text) {
					this.post({ type: 'final', text });
				}
				if (this.flushing) {
					this.finishFlush();
				}
			});
			this.recognizer.on('error', (m) => this.post({ type: 'error', message: String(m && m.error || 'Vosk error') }));
			this.post({ type: 'progress', loaded: 1, total: 1 });
			this.post({ type: 'ready', model: spec.label, device: 'WebAssembly', ms: Math.round(performance.now() - t0), reason: 'chosen' });
		},
		audio(samples) {
			if (!this.recognizer) {
				return;
			}
			let sum = 0;
			for (let i = 0; i < samples.length; i++) {
				sum += samples[i] * samples[i];
			}
			const rms = Math.sqrt(sum / (samples.length || 1));
			const ms = samples.length / SR * 1000;
			if (rms > Math.max(0.01, this.noise * 3)) {
				this.speaking = true;
				this.silenceMs = 0;
			} else {
				this.noise = this.noise * 0.95 + rms * 0.05;
				this.silenceMs += ms;
				if (this.silenceMs > 700) {
					this.speaking = false;
				}
			}
			if (++this.levelTick % 2 === 0) {
				this.post({ type: 'level', speaking: this.speaking, level: Math.min(1, rms * 8) });
			}
			this.recognizer.acceptWaveformFloat(samples, SR);
		},
		finishFlush() {
			clearTimeout(this.flushTimer);
			this.flushing = false;
			this.speaking = false;
			this.post({ type: 'done' });
		},
		postMessage(data) {
			const run = async () => {
				if (data.type === 'init') {
					await this.init(data);
				} else if (data.type === 'audio') {
					this.audio(data.samples);
				} else if (data.type === 'live') {
					// Vosk streams at no extra cost: 'auto' keeps the partial texts, only 'off' removes them
					this.live = data.mode !== 'off';
				} else if (data.type === 'flush') {
					if (!this.recognizer) {
						this.post({ type: 'done' });
						return;
					}
					this.flushing = true;
					this.recognizer.retrieveFinalResult();
					// the final result event ends the flush; a silent recognizer may not send one
					this.flushTimer = setTimeout(() => this.flushing && this.finishFlush(), 3000);
				}
			};
			run().catch((e) => {
				console.error(e);
				this.post({ type: 'error', message: String(e && e.message || e) });
			});
		},
		terminate() {
			clearTimeout(this.flushTimer);
			try { this.recognizer && this.recognizer.remove(); } catch (e) { /* gone */ }
			try { this.model && this.model.terminate(); } catch (e) { /* gone */ }
			this.recognizer = this.model = null;
			this.onmessage = null;
		},
	};
	return adapter;
}

export const voskLanguages = Object.keys(VOSK_MODELS);
