// Offline real-time speech-to-text worker. Every file (library, WASM runtime, models) is served by this project.
//
// The model follows the device: Whisper small (q4) on WebGPU for a computer, Whisper base (q8) on WebAssembly
// everywhere else. Whisper is not a streaming model, so the live text comes from a sliding window: a voice
// detector cuts the speech into utterances, the utterance in progress is transcribed again as soon as the
// previous pass ends (partial text), and once the speaker pauses it is transcribed one last time (final text).
//
// In:  {type:'init', model:'auto'|'base'|'small', language, task:'transcribe'|'translate', modelUrls:{base, small}}
//      (modelUrls: folder holding onnx-community/<model>/; translate writes English whatever the spoken language)
//      | {type:'audio', samples: Float32Array mono 16 kHz}
//      | {type:'flush'} (end of recording: finalize the utterance in progress)
// Out: {type:'progress', loaded, total} | {type:'ready', model, device, dtype, ms, reason}
//      | {type:'partial', text} | {type:'final', text} | {type:'level', speaking, level}
//      | {type:'stats', kind, ms, audioS} | {type:'done'} (after a flush) | {type:'error', message}
import { env, pipeline } from './lib/transformers.min.js';

const base = new URL('./', import.meta.url).href;
const SR = 16000;

// The models come from the URLs the page gives (by default the model projects deployed on the same Convertigo
// server), never from the Hugging Face hub or a CDN. transformers.js calls them "remote" because 4.3.2 skips the
// file checks of a local model path given as an absolute URL.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remotePathTemplate = '{model}/';
env.useBrowserCache = true; // Cache Storage keeps the models after the first load
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

// Measured on a Mac (Chromium, one WASM thread), one pass on 5 s of audio:
// small WebGPU q4 0.5 s, base encoder WebGPU q4 + decoder WASM q8 0.47 s, base WASM q8 2.3 s.
const CONFIGS = {
	small: { model: 'onnx-community/whisper-small', device: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, label: 'Whisper small (q4)', where: 'WebGPU' },
	baseGpu: { model: 'onnx-community/whisper-base', device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: { encoder_model: 'q4', decoder_model_merged: 'q8' }, label: 'Whisper base', where: 'WebGPU + WebAssembly' },
	base: { model: 'onnx-community/whisper-base', device: 'wasm', dtype: 'q8', label: 'Whisper base (q8)', where: 'WebAssembly' },
};

const PROJECTS = { base: 'lib_SpeechToText_model_whisperBase', small: 'lib_SpeechToText_model_whisperSmall' };

let asr = null;
let current = null;
let language = '';
let task = 'transcribe';
let modelUrls = {};

function modelKind(key) {
	return key === 'small' ? 'small' : 'base';
}

// true when the model answers at its URL (its model project is deployed there). A Convertigo server answers 200
// with a JSON error for a missing file, so the check reads config.json itself.
async function available(key) {
	const cfg = CONFIGS[key];
	const url = modelUrls[modelKind(key)] + cfg.model + '/config.json';
	try {
		const r = await fetch(url, { method: 'GET', cache: 'no-store' });
		if (!r.ok) return false;
		const config = await r.json();
		return config && config.model_type === 'whisper';
	} catch (e) {
		return false;
	}
}

function isMobile() {
	if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile;
	return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

async function hasWebGPU() {
	try {
		if (!navigator.gpu) return false;
		const adapter = await navigator.gpu.requestAdapter();
		return !!adapter;
	} catch (e) {
		return false;
	}
}

async function choose(wanted) {
	const gpu = await hasWebGPU();
	if (wanted === 'small') {
		return gpu ? { key: 'small', reason: 'chosen' } : { key: 'small', wasm: true, reason: 'chosen, without WebGPU: slow' };
	}
	if (wanted === 'base') return { key: gpu ? 'baseGpu' : 'base', reason: 'chosen' };
	if (!gpu) return { key: 'base', reason: 'auto: no WebGPU' };
	if (isMobile()) return { key: 'baseGpu', reason: 'auto: phone or tablet with WebGPU' };
	return { key: 'small', reason: 'auto: computer with WebGPU' };
}

function usesGpu(device) {
	return device === 'webgpu' || (typeof device === 'object' && Object.values(device).includes('webgpu'));
}

async function load(wanted) {
	const t0 = performance.now();
	const pick = await choose(wanted);
	if (!(await available(pick.key))) {
		if (modelKind(pick.key) === 'small' && wanted !== 'small' && (await available('base'))) {
			// auto on a computer, but only the base model project is deployed
			const gpu = pick.key === 'small' && !pick.wasm;
			pick.key = gpu ? 'baseGpu' : 'base';
			pick.wasm = false;
			pick.reason = 'auto: ' + PROJECTS.small + ' not deployed, base instead';
		} else {
			const project = PROJECTS[modelKind(pick.key)];
			throw new Error('Model not found at ' + modelUrls[modelKind(pick.key)] + ': deploy the project ' + project + ' on the server, or set modelsUrl.');
		}
	}
	const cfg = { ...CONFIGS[pick.key] };
	env.remoteHost = modelUrls[modelKind(pick.key)];
	if (pick.wasm) { cfg.device = 'wasm'; cfg.where = 'WebAssembly'; }
	// the WebGPU runtime is the asyncify build; the plain build is lighter for WebAssembly only
	const variant = usesGpu(cfg.device) ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded';
	env.backends.onnx.wasm.wasmPaths = { mjs: base + 'lib/' + variant + '.mjs', wasm: base + 'lib/' + variant + '.wasm' };
	const files = {};
	const progress_callback = (p) => {
		if (p.status === 'progress' && p.file) {
			files[p.file] = p;
			let loaded = 0, total = 0;
			for (const k in files) { loaded += files[k].loaded || 0; total += files[k].total || 0; }
			postMessage({ type: 'progress', loaded, total });
		}
	};
	try {
		asr = await pipeline('automatic-speech-recognition', cfg.model, { device: cfg.device, dtype: cfg.dtype, progress_callback });
	} catch (e) {
		if (!usesGpu(cfg.device)) throw e;
		// WebGPU announced but unusable: fall back to Whisper base on WebAssembly
		console.warn('WebGPU failed, falling back to WebAssembly', e);
		Object.assign(cfg, CONFIGS.base);
		pick.reason = 'WebGPU failed, WebAssembly instead';
		env.remoteHost = modelUrls.base;
		asr = await pipeline('automatic-speech-recognition', cfg.model, { device: 'wasm', dtype: cfg.dtype, progress_callback });
	}
	// warm-up: the first run compiles the WebGPU shaders / WASM paths
	await asr(new Float32Array(SR), { ...decodeOptions(), max_new_tokens: 4 });
	current = cfg;
	postMessage({ type: 'ready', model: cfg.label, device: cfg.where, ms: Math.round(performance.now() - t0), reason: pick.reason });
}

// ---- voice detection and utterances ----

const FRAME = 480;               // 30 ms
const PREROLL = 0.4 * SR;        // audio kept before the speech starts
const END_SILENCE_MS = 700;      // pause that ends an utterance
const MAX_UTTERANCE = 20 * SR;   // longer utterances are cut
const MIN_STEP = 0.5 * SR;       // new audio needed before a new partial pass

let noise = 0.003;
let speaking = false;
let speechFrames = 0;
let silenceMs = 0;
let lastSpeechAt = 0;            // length of utt at the last speech frame
let preroll = new Float32Array(0);
let utt = null;                  // Float32Array of the utterance in progress
let uttLen = 0;
let uttId = 0;
let partialAt = 0;               // uttLen at the last partial pass
const finals = [];               // utterances waiting for their final pass
let busy = false;
let levelTick = 0;

function append(samples) {
	if (uttLen + samples.length > utt.length) {
		const bigger = new Float32Array(Math.max(utt.length * 2, uttLen + samples.length));
		bigger.set(utt.subarray(0, uttLen));
		utt = bigger;
	}
	utt.set(samples, uttLen);
	uttLen += samples.length;
}

function endUtterance() {
	if (!utt) return;
	const keep = Math.min(uttLen, lastSpeechAt + 0.25 * SR);
	if (keep > 0.3 * SR) finals.push({ id: uttId, audio: utt.slice(0, keep) });
	utt = null;
	uttLen = 0;
	speaking = false;
	speechFrames = 0;
	silenceMs = 0;
	partialAt = 0;
}

function onAudio(samples) {
	let maxRms = 0;
	for (let off = 0; off < samples.length; off += FRAME) {
		const frame = samples.subarray(off, Math.min(off + FRAME, samples.length));
		let sum = 0;
		for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
		const rms = Math.sqrt(sum / frame.length);
		maxRms = Math.max(maxRms, rms);
		// low floor for quiet laptop microphones; above the floor, three times the measured background noise
		const isSpeech = rms > Math.max(0.005, noise * 3);
		if (!isSpeech) noise = noise * 0.95 + rms * 0.05;
		if (!speaking) {
			speechFrames = isSpeech ? speechFrames + 1 : 0;
			const p = new Float32Array(Math.min(PREROLL, preroll.length + frame.length));
			const all = new Float32Array(preroll.length + frame.length);
			all.set(preroll);
			all.set(frame, preroll.length);
			p.set(all.subarray(all.length - p.length));
			preroll = p;
			if (speechFrames >= 3) {
				speaking = true;
				uttId++;
				utt = new Float32Array(10 * SR);
				uttLen = 0;
				append(preroll);
				lastSpeechAt = uttLen;
				preroll = new Float32Array(0);
				silenceMs = 0;
			}
		} else {
			append(frame);
			if (isSpeech) {
				silenceMs = 0;
				lastSpeechAt = uttLen;
			} else {
				silenceMs += frame.length / SR * 1000;
				if (silenceMs >= END_SILENCE_MS) endUtterance();
			}
			if (speaking && uttLen >= MAX_UTTERANCE) endUtterance();
		}
	}
	if (++levelTick % 2 === 0) postMessage({ type: 'level', speaking, level: Math.min(1, maxRms * 8) });
	pump();
}

// ---- transcription scheduling ----

// Phrases Whisper invents on noise or silence (learnt from subtitled videos), in the main languages; a pass that
// gives one of them is dropped.
const HALLUCINATIONS = new RegExp([
	'^\\W*$', 'amara\\.org', '^\\s*[\\[(]?(music|musique|música|musik|musica|applause|applaudissements)[\\])]?\\W*$',
	// English
	'thanks? (you )?for watching', 'subtitles? (by|made by|created by)', 'please subscribe', 'like and subscribe',
	// French
	'sous-titr', 'merci d.avoir regard', 'abonnez-vous',
	// Spanish
	'subt[ií]tulos? (realizados )?por', 'gracias por ver', 'suscr[ií]bete',
	// German
	'untertitel (im auftrag|der amara|von)', 'danke f[üu]rs zuschauen', 'abonniert (den|meinen) kanal',
	// Italian
	'sottotitoli (creati|a cura)', 'grazie per la visione', 'iscriviti al canale',
	// Portuguese
	'legendas? (pela|por)', 'obrigad[oa] por assistir', 'inscreva-se',
].join('|'), 'i');

function clean(text) {
	const t = (text || '').replace(/\s+/g, ' ').trim();
	return HALLUCINATIONS.test(t) ? '' : t;
}

// language: the Whisper name of the spoken language, or empty to detect it; task: 'transcribe' writes in that language,
// 'translate' writes English (Whisper only translates to English)
function decodeOptions() {
	return language ? { language, task } : { task };
}

async function run(audio) {
	const t0 = performance.now();
	const out = await asr(audio, { ...decodeOptions(), max_new_tokens: 160 });
	return { text: clean(out.text), ms: Math.round(performance.now() - t0) };
}

async function pump() {
	if (busy || !asr) return;
	busy = true;
	try {
		while (true) {
			if (finals.length) {
				const f = finals.shift();
				const r = await run(f.audio);
				postMessage({ type: 'final', text: r.text });
				postMessage({ type: 'stats', kind: 'final', ms: r.ms, audioS: f.audio.length / SR });
				continue;
			}
			if (speaking && utt && uttLen >= SR && uttLen - partialAt >= MIN_STEP) {
				const id = uttId;
				partialAt = uttLen;
				const audio = utt.slice(0, uttLen);
				const r = await run(audio);
				// a final pass may have closed this utterance meanwhile
				if (id === uttId && speaking) postMessage({ type: 'partial', text: r.text });
				postMessage({ type: 'stats', kind: 'partial', ms: r.ms, audioS: audio.length / SR });
				continue;
			}
			break;
		}
	} catch (e) {
		console.error(e);
		postMessage({ type: 'error', message: String(e && e.message || e) });
	} finally {
		busy = false;
	}
	// "done" only once the flush and every audio chunk sent before it have been transcribed
	if (flushed && !finals.length && !speaking) {
		flushed = false;
		postMessage({ type: 'done' });
	}
}

let flushed = false;

self.onmessage = async ({ data }) => {
	try {
		if (data.type === 'init') {
			language = data.language ? String(data.language) : '';
			task = data.task === 'translate' ? 'translate' : 'transcribe';
			modelUrls = data.modelUrls || {};
			await load(data.model || 'auto');
		} else if (data.type === 'audio') {
			onAudio(data.samples);
		} else if (data.type === 'flush') {
			if (speaking) endUtterance();
			preroll = new Float32Array(0);
			flushed = true;
			pump();
		}
	} catch (e) {
		console.error(e);
		postMessage({ type: 'error', message: String(e && e.message || e) });
	}
};
