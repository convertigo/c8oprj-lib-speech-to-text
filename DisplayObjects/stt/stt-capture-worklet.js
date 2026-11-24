// AudioWorklet: turns the microphone (any sample rate) into mono 16 kHz Float32 chunks of about 100 ms,
// posted to the page, which forwards them to the speech-to-text worker.
class SttCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.ratio = sampleRate / 16000; // input samples per output sample
		this.pos = 0;                    // position of the next output sample in the input stream
		this.prev = 0;                   // last input sample of the previous block (interpolation)
		this.out = new Float32Array(1600);
		this.n = 0;
	}

	process(inputs) {
		const input = inputs[0];
		if (!input || !input[0]) {
			return true;
		}
		const ch0 = input[0];
		const ch1 = input[1];
		const len = ch0.length;
		const at = (i) => {
			if (i < 0) return this.prev;
			return ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
		};
		const r = this.ratio;
		while (this.pos < len) {
			let v;
			if (r >= 2) {
				// average the input samples covered by this output sample (simple low-pass)
				const start = Math.max(0, Math.floor(this.pos - r / 2));
				const end = Math.min(len - 1, Math.floor(this.pos + r / 2));
				let sum = 0;
				for (let i = start; i <= end; i++) sum += at(i);
				v = sum / (end - start + 1);
			} else {
				const i = Math.floor(this.pos);
				const f = this.pos - i;
				v = at(i - 1 < -1 ? -1 : i) * (1 - f) + at(Math.min(i + 1, len - 1)) * f;
			}
			this.out[this.n++] = v;
			if (this.n === this.out.length) {
				this.port.postMessage(this.out, [this.out.buffer]);
				this.out = new Float32Array(1600);
				this.n = 0;
			}
			this.pos += r;
		}
		this.pos -= len;
		this.prev = at(len - 1);
		return true;
	}
}

registerProcessor('stt-capture', SttCapture);
